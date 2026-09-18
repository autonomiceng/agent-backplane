// Requests bind a held Delivery, row proposal or Migration preview to an expiring Approval.
import { Buffer } from "node:buffer";
import { prepareSql } from "../sql/prepare-sql.ts";
import { proposalTarget, rowTarget } from "./row-target.ts";
import { migrationRequestPolicy } from "./approval-migration-policy.ts";
import { migrationPreviewTarget } from "./migration-target.ts";
import { actionHash } from "./gate-policy.ts";
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { holdIn } from "../queue/hold.ts";
import { approvalWrite, type ApprovalResult } from "./approval-transaction.ts";
import type { requestInput, requestResponse } from "./request-input.ts";
export type RequestApprovalResult = ApprovalResult<typeof requestResponse.static>;
export function requestApproval(pool: Pool, context: Extract<RunContext, { principalId: string }>, input: typeof requestInput.static): Promise<RequestApprovalResult> {
  if ("targetKind" in input) return approvalWrite(pool, context, "approval.request", [], async (tx, emit) => {
    let target, hash;
    if (input.targetKind === "migration") {
      target = await migrationPreviewTarget(tx, context, input);
      const reason = migrationRequestPolicy(target, input.expectedRevision);
      if (reason) throw new Error(reason);
      hash = input.sqlHash;
    } else {
      const prepared = await prepareSql(context, input.sql);
      if (!prepared.ok) throw new Error("approval_target_unsupported");
      target = await proposalTarget(tx, context.workspaceId, prepared);
      const requested = await rowTarget(tx, context.workspaceId, input.table, input.primaryKey);
      if (target.targetId !== requested.targetId) throw new Error("approval_mismatch");
      if (target.targetVersion !== input.targetVersion) throw new Error("approval_stale");
      hash = actionHash(input.sql, target.targetId);
    }
    const [row] = await tx<{ id: string; expiresAt: Date }[]>`WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS now)
      INSERT INTO control.approvals (workspace_id,target_kind,target_id,target_version,requested_by,requested_run_id,
        gate_epoch,action_hash,row_table,row_key,preview_position,created_at,expires_at)
      SELECT ${context.workspaceId},${input.targetKind},${target.targetId},${target.targetVersion},${context.principalId},${context.runId},
        ${target.epoch},${Buffer.from(hash, "hex")},${target.table},${target.primaryKey}::text::jsonb,${input.targetKind === "migration" ? input.previewPosition : null},
        now,now + ${input.expiresInSeconds ?? 3600} * interval '1 second' FROM stamp RETURNING id,expires_at AS "expiresAt"`;
    if (!row) throw new Error("approval_unavailable");
    await emit("approval.request", [row.id], 1, { targetKind: input.targetKind, targetId: target.targetId, targetVersion: target.targetVersion, actionHash: hash });
    return { id: row.id, targetKind: input.targetKind, targetId: target.targetId, targetVersion: target.targetVersion,
      expiresAt: row.expiresAt.toISOString(), actionHash: hash };
  });
  const deliveryId = input.deliveryId.toLowerCase();
  return approvalWrite(pool, context, "approval.request", [deliveryId], async (tx, emit) => {
    await holdIn(tx, emit, context.workspaceId, deliveryId, input.receipt);
    const [held] = await tx<{ version: string }[]>`SELECT envelope->>'held_at' AS version FROM queue.delivery_envelopes
      WHERE workspace_id = ${context.workspaceId} AND id = ${deliveryId}`;
    if (!held) throw new Error("approval_unavailable");
    const [row] = await tx<(Omit<typeof requestResponse.static, "expiresAt"> & { expiresAt: Date })[]>`
      WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS now)
      INSERT INTO control.approvals (workspace_id, target_kind, target_id, target_version, requested_by, requested_run_id, created_at, expires_at)
      SELECT ${context.workspaceId}, 'message', ${deliveryId}, ${held.version}, ${context.principalId}, ${context.runId},
        now, now + ${input.expiresInSeconds ?? 3600} * interval '1 second' FROM stamp
      RETURNING id, target_kind AS "targetKind", target_id AS "targetId", target_version AS "targetVersion", expires_at AS "expiresAt"`;
    if (!row) throw new Error("approval_unavailable");
    const result = { ...row, expiresAt: row.expiresAt.toISOString() };
    await emit("approval.request", [row.id, deliveryId], 1,
      { targetKind: row.targetKind, targetVersion: row.targetVersion, expiresAt: result.expiresAt });
    return result;
  });
}
