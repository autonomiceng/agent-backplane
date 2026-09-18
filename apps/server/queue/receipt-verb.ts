// Receipt verbs share hashing, bound execution and rejection recording; SQL owns the transition.
import { createHash } from "node:crypto";
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext, type EmitAudit, type RunTransaction } from "../runs/with-run-context.ts";
import { emitDeliveryEvents, type DeliveryResult } from "./delivery-result.ts";
import { queueError, type QueueError } from "./queue-error.ts";

type ReceiptState = { renew: "leased" | "begun"; ack: "succeeded"; nack: "scheduled" | "dead-lettered" | "ambiguous" };
type ReceiptVerb = keyof ReceiptState;

export function hashReceipt(receipt: string): Buffer {
  return createHash("sha256").update(receipt).digest();
}

export async function receiptVerbIn<Verb extends ReceiptVerb>(tx: RunTransaction, emit: EmitAudit, workspaceId: string, deliveryId: string, receipt: string, verb: Verb): Promise<NonNullable<DeliveryResult<ReceiptState[Verb]>["data"]>> {
  const receiptHash = hashReceipt(receipt);
  const [row] = await (verb === "renew"
    ? tx<{ result: DeliveryResult<ReceiptState[Verb]> }[]>`SELECT queue.renew(${workspaceId}, ${deliveryId}, ${receiptHash}) AS result`
    : verb === "ack"
      ? tx<{ result: DeliveryResult<ReceiptState[Verb]> }[]>`SELECT queue.ack(${workspaceId}, ${deliveryId}, ${receiptHash}) AS result`
      : tx<{ result: DeliveryResult<ReceiptState[Verb]> }[]>`SELECT queue.nack(${workspaceId}, ${deliveryId}, ${receiptHash}) AS result`);
  if (!row?.result.data) throw new Error("queue_unavailable");
  await emitDeliveryEvents(emit, row.result);
  return row.result.data;
}

export async function receiptVerb<Verb extends ReceiptVerb>(pool: Pool, context: Extract<RunContext, { principalId: string }>, deliveryId: string, receipt: string, verb: Verb): Promise<
  { ok: true; delivery: NonNullable<DeliveryResult<ReceiptState[Verb]>["data"]> } | { ok: false; reason: QueueError }
> {
  try {
    const delivery = await withRunContext(pool, context, (tx, emit) => receiptVerbIn(tx, emit, context.workspaceId, deliveryId, receipt, verb));
    return { ok: true, delivery };
  } catch (error) {
    const failure = queueError(error);
    await recordRejection(pool, { context, kind: `queue.${verb}`, objects: [deliveryId], ...failure });
    return { ok: false, reason: failure.reason };
  }
}
