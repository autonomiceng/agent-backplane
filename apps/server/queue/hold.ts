// Hold owns the HTTP transaction; holdIn joins a bound transaction for atomic handoffs.
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext, type EmitAudit, type RunTransaction } from "../runs/with-run-context.ts";
import { serializeDelivery, type DeliveryEnvelope, type RecoveryResult } from "./delivery-envelope.ts";
import { emitDeliveryEvents } from "./delivery-result.ts";
import { queueError, type QueueError } from "./queue-error.ts";
import { hashReceipt } from "./receipt-verb.ts";

export async function holdIn(tx: RunTransaction, emit: EmitAudit, workspaceId: string, deliveryId: string, receipt: string): Promise<DeliveryEnvelope> {
  const receiptHash = hashReceipt(receipt);
  const [row] = await tx<{ result: RecoveryResult }[]>`SELECT queue.hold(${workspaceId}, ${deliveryId}, ${receiptHash}) AS result`;
  if (!row?.result.data) throw new Error("queue_unavailable");
  await emitDeliveryEvents(emit, row.result);
  return serializeDelivery(row.result.data);
}

export async function hold(pool: Pool, context: Extract<RunContext, { principalId: string }>, deliveryId: string, receipt: string): Promise<
  { ok: true; delivery: DeliveryEnvelope } | { ok: false; reason: QueueError }
> {
  try {
    const delivery = await withRunContext(pool, context, (tx, emit) => holdIn(tx, emit, context.workspaceId, deliveryId, receipt));
    return { ok: true, delivery };
  } catch (error) {
    const failure = queueError(error);
    await recordRejection(pool, { context, kind: "queue.hold", objects: [deliveryId], ...failure });
    return { ok: false, reason: failure.reason };
  }
}
