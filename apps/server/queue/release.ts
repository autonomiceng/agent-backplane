// Release checks Organization membership inside the User's bound transaction.
import { queryWorkspaceAccess } from "../auth/workspace-access-query.ts";
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext, type EmitAudit, type RunTransaction } from "../runs/with-run-context.ts";
import { serializeDelivery, type DeliveryEnvelope, type RecoveryResult } from "./delivery-envelope.ts";
import { emitDeliveryEvents } from "./delivery-result.ts";
import { queueError, type QueueError } from "./queue-error.ts";

export async function releaseIn(tx: RunTransaction, emit: EmitAudit, workspaceId: string, deliveryId: string): Promise<DeliveryEnvelope> {
  const [row] = await tx<{ result: RecoveryResult }[]>`SELECT queue.release(${workspaceId}, ${deliveryId}) AS result`;
  if (!row?.result.data) throw new Error("queue_unavailable");
  await emitDeliveryEvents(emit, row.result);
  return serializeDelivery(row.result.data);
}

export async function release(pool: Pool, context: Extract<RunContext, { userId: string }>, deliveryId: string): Promise<
  { ok: true; delivery: DeliveryEnvelope } | { ok: false; reason: QueueError }
> {
  try {
    const delivery = await withRunContext(pool, context, async (tx, emit) => {
      const access = await queryWorkspaceAccess(tx, context.userId, context.workspaceId);
      if (!access.allowed) throw new Error("recovery_forbidden");
      return releaseIn(tx, emit, context.workspaceId, deliveryId);
    });
    return { ok: true, delivery };
  } catch (error) {
    const failure = queueError(error);
    await recordRejection(pool, { context, kind: "queue.release", objects: [deliveryId], ...failure });
    return { ok: false, reason: failure.reason };
  }
}
