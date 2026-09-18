// Cancel checks Organization membership inside the User's bound transaction.
import { queryWorkspaceAccess } from "../auth/workspace-access-query.ts";
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { serializeDelivery, type DeliveryEnvelope, type RecoveryResult } from "./delivery-envelope.ts";
import { emitDeliveryEvents } from "./delivery-result.ts";
import { queueError, type QueueError } from "./queue-error.ts";
import type { CancelInput } from "./cancel-input.ts";

export async function cancel(pool: Pool, context: Extract<RunContext, { userId: string }>, deliveryId: string, input: CancelInput): Promise<
  { ok: true; delivery: DeliveryEnvelope } | { ok: false; reason: QueueError }
> {
  try {
    const delivery = await withRunContext(pool, context, async (tx, emit) => {
      const access = await queryWorkspaceAccess(tx, context.userId, context.workspaceId);
      if (!access.allowed) throw new Error("recovery_forbidden");
      const [row] = await tx<{ result: RecoveryResult }[]>`SELECT queue.cancel(${context.workspaceId}, ${deliveryId}, ${input.force}, ${input.reason}) AS result`;
      if (!row?.result.data) throw new Error("queue_unavailable");
      await emitDeliveryEvents(emit, row.result);
      return serializeDelivery(row.result.data);
    });
    return { ok: true, delivery };
  } catch (error) {
    const failure = queueError(error);
    await recordRejection(pool, { context, kind: "queue.cancel", objects: [deliveryId], ...failure });
    return { ok: false, reason: failure.reason };
  }
}
