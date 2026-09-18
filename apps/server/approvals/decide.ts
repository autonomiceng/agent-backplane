// Decisions authorize and fence target versions under the cursor lock; only Messages release Deliveries.
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { migrationTarget } from "./migration-target.ts";
import { rowTarget } from "./row-target.ts";
import { releaseIn } from "../queue/release.ts";
import { approvalWrite, type ApprovalResult } from "./approval-transaction.ts";
import { approvalMember } from "../auth/decision-session.ts";
import { decisionPolicy } from "./decision-policy.ts";
import type { decideInput, decideResponse } from "./decide-input.ts";
export type DecideApprovalResult = ApprovalResult<typeof decideResponse.static>;
export function decideApproval(pool: Pool, context: RunContext, id: string, input: typeof decideInput.static): Promise<DecideApprovalResult> {
  return approvalWrite(pool, context, "approval.decide", [id], async (tx, emit) => {
    let delegatedByUserId: string | null = null;
    if ("userId" in context) await approvalMember(tx, context);
    else {
      const [member] = await tx<{ userId: string }[]>`SELECT m."userId" AS "userId" FROM control.member m
        JOIN control.workspaces w ON w.organization_id = m."organizationId"
        JOIN control.approval_delegations d ON d.workspace_id = w.id AND d.member_id = m.id AND d.granted_by = m."userId"
        WHERE w.id = ${context.workspaceId} AND d.principal_id = ${context.principalId} ORDER BY m.id FOR SHARE OF m`;
      if (!member) throw new Error("approval_forbidden");
      delegatedByUserId = member.userId;
      await tx`SELECT principal_id FROM control.approval_delegations
        WHERE workspace_id = ${context.workspaceId} AND principal_id = ${context.principalId} FOR SHARE`;
    }
    const [settings] = await tx<{ allow: boolean }[]>`SELECT allow_self_approval AS allow FROM control.approval_settings
      WHERE workspace_id = ${context.workspaceId} FOR SHARE`;
    const allowSelfApproval = settings?.allow ?? false;
    const [approval] = await tx<{
      gate_epoch: string; target_kind: string; target_id: string; target_version: string; requested_by: string;
      requested_run_principal_id: string; decided: boolean; expired: boolean; row_table: string; row_key: string;
    }[]>`SELECT a.gate_epoch, a.target_kind, a.target_id, a.target_version, a.requested_by, a.row_table, a.row_key::text, r.principal_id AS requested_run_principal_id,
        a.decision IS NOT NULL AS decided, a.expires_at <= clock_timestamp() AS expired
      FROM control.approvals a JOIN control.runs r ON r.id = a.requested_run_id
      WHERE a.workspace_id = ${context.workspaceId} AND a.id = ${id} FOR UPDATE OF a`;
    if (!approval) throw new Error("approval_not_found");
    if (approval.decided) throw new Error("approval_decided");
    if (approval.expired) throw new Error("approval_expired");
    // The bound Workspace cursor stabilizes this read; releaseIn locks the Delivery before redispatch.
    const [held] = approval.target_kind === "message" ? await tx<{ current: boolean; state: string; version: string | null }[]>`
      SELECT (envelope->>'current')::boolean AS current, state, envelope->>'held_at' AS version
      FROM queue.delivery_envelopes WHERE workspace_id = ${context.workspaceId} AND id = ${approval.target_id}::uuid` : [];
    const row = approval.target_kind === "row" ? await rowTarget(tx, context.workspaceId, approval.row_table,
      approval.row_key).catch((error: unknown) => {
        if (error instanceof Error && ["approval_gate_not_found", "approval_target_not_found"].includes(error.message)) throw new Error("approval_stale");
        throw error;
      }) : null;
    const migration = approval.target_kind === "migration" ? await migrationTarget(tx, context.workspaceId) : null;
    if (migration && (!migration.epoch || migration.epoch !== approval.gate_epoch)) throw new Error("approval_stale");
    const reason = decisionPolicy({ targetKind: approval.target_kind, decided: approval.decided, expired: approval.expired,
      current: migration !== null || row !== null || (held?.current ?? false), state: held?.state ?? null,
      targetVersion: approval.target_version, heldVersion: migration?.targetVersion ?? row?.targetVersion ?? held?.version ?? null, allowSelfApproval,
      principalId: "principalId" in context ? context.principalId : null,
      requestedBy: approval.requested_by, requestedRunPrincipalId: approval.requested_run_principal_id });
    if (reason) throw new Error(reason);
    const releasedDeliveryId = input.decision === "approve" && approval.target_kind === "message"
      ? (await releaseIn(tx, emit, context.workspaceId, approval.target_id)).id : null;
    const position = await emit("approval.decide", [id, approval.target_id], 1, {
      targetKind: approval.target_kind, targetVersion: approval.target_version, ...input,
      releasedDeliveryId, allowSelfApproval, delegatedByUserId,
    });
    await tx`UPDATE control.approvals SET decision = ${input.decision}, reason = ${input.reason},
      decision_position = ${position.toString()}, released_delivery_id = ${releasedDeliveryId}
      WHERE workspace_id = ${context.workspaceId} AND id = ${id}`;
    return { id, decision: input.decision, releasedDeliveryId };
  });
}
