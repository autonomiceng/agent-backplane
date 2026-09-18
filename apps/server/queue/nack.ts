// Nack exposes the Receipt-fenced transition to HTTP callers.
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import type { Nack } from "./nack-input.ts";
import type { QueueError } from "./queue-error.ts";
import { receiptVerb } from "./receipt-verb.ts";

export async function nack(pool: Pool, context: Extract<RunContext, { principalId: string }>, deliveryId: string, receipt: string): Promise<
  { ok: true; delivery: Nack } | { ok: false; reason: QueueError }
> {
  const result = await receiptVerb(pool, context, deliveryId, receipt, "nack");
  if (!result.ok) return result;
  const { delivery } = result;
  return { ok: true, delivery: { deliveryId: delivery.id, state: delivery.state, nextAttemptAt: delivery.next_attempt_at } };
}
