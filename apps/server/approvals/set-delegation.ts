// Delegations bind to the grantor's exact membership; re-enrollment requires a fresh grant.
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { approvalWrite, type ApprovalResult } from "./approval-transaction.ts";
import { approvalMember } from "../auth/decision-session.ts";
import type { setDelegationResponse } from "./set-delegation-input.ts";
export type SetDelegationResult = ApprovalResult<typeof setDelegationResponse.static>;
export function setDelegation(pool: Pool, context: Extract<RunContext, { userId: string }>, principalId: string, enabled: boolean): Promise<SetDelegationResult> {
  return approvalWrite(pool, context, "approval.delegation", [principalId], async (tx, emit) => {
    const memberId = await approvalMember(tx, context);
    const [principal] = await tx`SELECT id FROM control.principals WHERE workspace_id = ${context.workspaceId}
      AND id = ${principalId} AND system IS NULL AND (${!enabled} OR status = 'active')`;
    if (!principal) throw new Error("principal_not_found");
    const [changed] = enabled ? await tx<{ member_id: string }[]>`INSERT INTO control.approval_delegations (workspace_id, principal_id, granted_by, member_id)
      VALUES (${context.workspaceId}, ${principalId}, ${context.userId}, ${memberId})
      ON CONFLICT (workspace_id, principal_id) DO UPDATE SET granted_by = EXCLUDED.granted_by, member_id = EXCLUDED.member_id
      WHERE (approval_delegations.granted_by, approval_delegations.member_id) IS DISTINCT FROM (EXCLUDED.granted_by, EXCLUDED.member_id)
      RETURNING member_id` : await tx<{ member_id: string }[]>`DELETE FROM control.approval_delegations
      WHERE workspace_id = ${context.workspaceId} AND principal_id = ${principalId} RETURNING member_id`;
    if (changed) await emit("approval.delegation", [principalId], 1, { enabled, memberId: changed.member_id });
    return { principalId, enabled };
  });
}
