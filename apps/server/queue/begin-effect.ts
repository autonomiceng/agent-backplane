// Begin Effect binds the Receipt transition and its event in the consumer's transaction.
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import type { BeginEffect, BeginEffectInput } from "./begin-effect-input.ts";
import { emitDeliveryEvents, type DeliveryResult } from "./delivery-result.ts";
import { queueError, type QueueError } from "./queue-error.ts";
import { hashReceipt } from "./receipt-verb.ts";

export async function beginEffect(pool: Pool, context: Extract<RunContext, { principalId: string }>, deliveryId: string, input: BeginEffectInput): Promise<
  { ok: true; effect: BeginEffect } | { ok: false; reason: QueueError }
> {
  try {
    const effect = await withRunContext(pool, context, async (tx, emit) => {
      const receiptHash = hashReceipt(input.receipt);
      const [row] = await tx<{ result: { data: BeginEffect } & Pick<DeliveryResult, "events"> }[]>`
        SELECT queue.begin_effect(${context.workspaceId}, ${deliveryId}, ${receiptHash}, ${input.action}, ${input.destination}) AS result`;
      if (!row?.result.data) throw new Error("queue_unavailable");
      await emitDeliveryEvents(emit, row.result);
      return row.result.data;
    });
    return { ok: true, effect };
  } catch (error) {
    const failure = queueError(error);
    await recordRejection(pool, { context, kind: "effect.begin", objects: [deliveryId], ...failure });
    return { ok: false, reason: failure.reason };
  }
}
