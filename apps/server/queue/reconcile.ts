// Authorize under the Workspace cursor, then commit the decision, transition and event together.
import { approvalMember } from "../auth/decision-session.ts";
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import type { DeliveryResult } from "./delivery-result.ts";
import { queueError, type QueueError } from "./queue-error.ts";
import type { reconcileInput, reconcileResponse } from "./reconcile-input.ts";
export async function reconcile(pool: Pool, context: RunContext, input: typeof reconcileInput.static): Promise<
  { ok: true; value: typeof reconcileResponse.static } | { ok: false; reason: QueueError }
> {
  try {
    const value = await withRunContext(pool, context, async (tx, emit) => {
      if ("userId" in context) await approvalMember(tx, context);
      else {
        const [member] = await tx`SELECT m.id FROM control.member m
          JOIN control.workspaces w ON w.organization_id = m."organizationId"
          JOIN control.reconciliation_delegations d ON d.workspace_id = w.id AND d.member_id = m.id AND d.granted_by = m."userId"
          WHERE w.id = ${context.workspaceId} AND d.principal_id = ${context.principalId} ORDER BY m.id FOR SHARE OF m`;
        if (!member) throw new Error("reconciliation_forbidden");
      }
      const [row] = await tx<{ result: { data: Omit<typeof reconcileResponse.static, "decisionPosition"> & { decisionPosition: string | null } }
        & Pick<DeliveryResult, "events"> }[]>`SELECT queue.reconcile(${context.workspaceId}, ${input.deliveryId}, ${input.outcome}, ${input.evidence}) AS result`;
      if (!row) throw new Error("queue_unavailable");
      const { data, events } = row.result;
      let decisionPosition = data.decisionPosition;
      for (const event of events) {
        const position = await emit(event.kind, event.objects, 1, event.metadata);
        await tx`SELECT queue.finish_reconciliation(${context.workspaceId}, ${data.id}, ${position.toString()})`;
        decisionPosition = position.toString();
      }
      if (decisionPosition === null) throw new Error("queue_unavailable");
      return { ...data, decisionPosition };
    });
    return { ok: true, value };
  } catch (error) {
    const failure = queueError(error);
    await recordRejection(pool, { context, kind: "effect.reconciled", objects: [input.deliveryId], ...failure });
    return { ok: false, reason: failure.reason };
  }
}
