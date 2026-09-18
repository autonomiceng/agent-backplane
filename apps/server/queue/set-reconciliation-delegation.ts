// Delegation changes lock the User's exact membership before the definer persists the grant.
import { approvalMember } from "../auth/decision-session.ts";
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { queueError, type QueueError } from "./queue-error.ts";
import type { setReconciliationDelegationResponse } from "./set-reconciliation-delegation-input.ts";
export async function setReconciliationDelegation(pool: Pool, context: Extract<RunContext, { userId: string }>, principalId: string, enabled: boolean): Promise<
  { ok: true; value: typeof setReconciliationDelegationResponse.static } | { ok: false; reason: QueueError }
> {
  try {
    const value = await withRunContext(pool, context, async (tx, emit) => {
      await approvalMember(tx, context);
      const [row] = await tx<{ result: { changed: boolean; memberId: string | null } }[]>`
        SELECT queue.set_reconciliation_delegation(${context.workspaceId}, ${principalId}, ${enabled}) AS result`;
      if (!row) throw new Error("queue_unavailable");
      if (row.result.changed) await emit("reconciliation.delegation", [principalId], 1, { enabled, memberId: row.result.memberId });
      return { principalId, enabled };
    });
    return { ok: true, value };
  } catch (error) {
    const failure = queueError(error);
    await recordRejection(pool, { context, kind: "reconciliation.delegation", objects: [principalId], ...failure });
    return { ok: false, reason: failure.reason };
  }
}
