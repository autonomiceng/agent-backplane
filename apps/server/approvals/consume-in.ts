// SQL and Migration executors consume Approvals inside their execution transaction.
import type { RunContext } from "../runs/run-context.ts";
import type { RunTransaction, EmitAudit } from "../runs/with-run-context.ts";
import { migrationConsumptionPolicy, type MigrationApproval, type MigrationGate } from "./approval-migration-policy.ts";
import type { ApplyInput } from "../schema/apply-migration-input.ts";
import type { PreparedSql } from "../sql/prepare-sql.ts";
import { actionHash, GateError } from "./gate-policy.ts";
import { proposalTarget, rowTarget } from "./row-target.ts";
export async function lockRowApprovals(tx: RunTransaction, workspaceId: string, ids: string[]): Promise<void> {
  const rows = await tx<{ row_table: string; row_key: string }[]>`SELECT row_table,row_key::text
    FROM control.approvals WHERE workspace_id=${workspaceId} AND id=ANY(${tx.array(ids, "UUID")}) ORDER BY id FOR UPDATE`;
  const targets = await tx<{ row_table: string; row_key: string }[]>`SELECT a.row_table,a.row_key::text FROM control.approvals a
    JOIN pg_namespace n ON n.nspname='ws_' || replace(${workspaceId}::text,'-','')
    JOIN pg_class c ON c.relnamespace=n.oid AND n.nspname || '.' || c.relname=a.row_table
    WHERE a.workspace_id=${workspaceId} AND a.id=ANY(${tx.array(ids, "UUID")}) AND a.target_kind='row' AND a.consumed_position IS NULL
      AND a.decision='approve' AND a.expires_at>clock_timestamp()
      AND EXISTS (SELECT FROM control.approval_gates g WHERE g.workspace_id=a.workspace_id AND g.target_kind='row' AND g.selector=a.row_table AND g.enabled)
    ORDER BY c.oid,a.row_key::text`;
  if (rows.length !== new Set(ids).size) throw new GateError("approval_not_found");
  for (const row of targets) await rowTarget(tx, workspaceId, row.row_table, row.row_key).catch((error: unknown) => {
    if (error instanceof Error && error.message === "approval_target_not_found") throw new GateError("approval_stale");
    throw error;
  });
}
export async function checkRowApproval(tx: RunTransaction, context: RunContext, prepared: PreparedSql) {
  const { input, decision, schema } = prepared;
  if (decision.insertOnly) return null;
  const [gate] = decision.writeTable ? await tx`SELECT epoch FROM control.approval_gates WHERE workspace_id=${context.workspaceId}
    AND target_kind='row' AND selector=${`${schema}.${decision.writeTable}`} AND enabled` : [];
  if (!gate && !input.approvalId) return null;
  const [approval] = input.approvalId ? await tx<{ id: string; target_kind: string; target_id: string; target_version: string;
    row_table: string; requested_by: string; gate_epoch: string; action_hash: string; decision: string; consumed: boolean; expired: boolean; decision_position: string }[]>`
    SELECT id,target_kind,target_id,target_version,row_table,requested_by,gate_epoch,encode(action_hash,'hex') AS action_hash,decision,
      consumed_position IS NOT NULL AS consumed,expires_at<=clock_timestamp() AS expired,decision_position::text
    FROM control.approvals WHERE workspace_id=${context.workspaceId} AND id=${input.approvalId} FOR UPDATE` : [];
  if (input.approvalId && !approval) throw new GateError("approval_not_found");
  if (approval) {
    if (!("principalId" in context) || approval.requested_by !== context.principalId || approval.target_kind !== "row") throw new GateError("approval_mismatch");
    if (!gate) throw new GateError(approval.row_table === `${schema}.${decision.writeTable}` ? "approval_stale" : "approval_mismatch");
    if (approval.consumed) throw new GateError("approval_consumed");
    if (approval.expired) throw new GateError("approval_expired");
    if (approval.decision !== "approve") throw new GateError("approval_not_approved");
    if (input.expectRows !== 1 || approval.action_hash !== actionHash(input, approval.target_id)) throw new GateError("approval_mismatch");
  }
  let target;
  try { target = await proposalTarget(tx, context.workspaceId, prepared); }
  catch (error) {
    if (!approval && error instanceof Error && error.message === "approval_target_not_found") throw new GateError("approval_target_unsupported");
    throw error;
  }
  if (!approval) {
    const { targetKind, targetId, targetVersion, table, primaryKey } = target;
    throw new GateError("approval_required", { targetKind, targetId, targetVersion, table, primaryKey });
  }
  if (approval.target_id !== target.targetId) throw new GateError("approval_mismatch");
  if (approval.gate_epoch !== target.epoch || approval.target_version !== target.targetVersion) throw new GateError("approval_stale");
  return approval;
}
export async function consumeRowApproval(tx: RunTransaction, emit: EmitAudit, workspaceId: string,
  approval: NonNullable<Awaited<ReturnType<typeof checkRowApproval>>>, rowCount: string, operationIndex: number): Promise<void> {
  if (rowCount !== "1") throw new GateError("approval_mismatch");
  const position = await emit("approval.consume", [approval.id], 1, { approvalId: approval.id, targetKind: "row", targetId: approval.target_id,
    targetVersion: approval.target_version, actionHash: approval.action_hash, decisionPosition: approval.decision_position, operationIndex });
  await tx`UPDATE control.approvals SET consumed_position=${position.toString()} WHERE workspace_id=${workspaceId} AND id=${approval.id}`;
}

export async function consumeMigrationApproval(tx: RunTransaction, emit: EmitAudit,
  context: Extract<RunContext, { principalId: string }>, input: ApplyInput & { approvalId: string }, gate: MigrationGate): Promise<void> {
  const [approval] = await tx<MigrationApproval[]>`
    SELECT preview_position::text,target_kind,target_id,target_version,requested_by,gate_epoch,encode(action_hash,'hex') AS action_hash,decision,
      consumed_position IS NOT NULL AS consumed,expires_at<=clock_timestamp() AS expired,decision_position::text
    FROM control.approvals WHERE workspace_id=${context.workspaceId} AND id=${input.approvalId} FOR UPDATE`;
  const reason = migrationConsumptionPolicy(gate, input, context.principalId, approval);
  if (reason) throw new GateError(reason);
  if (!approval) throw new Error("approval_unavailable");
  const position = await emit("approval.consume", [input.approvalId], 1, { approvalId: input.approvalId, targetKind: "migration",
    targetId: approval.target_id, targetVersion: approval.target_version, actionHash: approval.action_hash, decisionPosition: approval.decision_position,
    previewPosition: approval.preview_position });
  await tx`UPDATE control.approvals SET consumed_position=${position.toString()} WHERE workspace_id=${context.workspaceId} AND id=${input.approvalId}`;
}
