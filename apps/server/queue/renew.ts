// Renew exposes the Receipt-fenced transition to HTTP callers.
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import type { Renew } from "./renew-input.ts";
import type { QueueError } from "./queue-error.ts";
import { receiptVerb } from "./receipt-verb.ts";

export async function renew(pool: Pool, context: Extract<RunContext, { principalId: string }>, deliveryId: string, receipt: string): Promise<
  { ok: true; delivery: Renew } | { ok: false; reason: QueueError }
> {
  const result = await receiptVerb(pool, context, deliveryId, receipt, "renew");
  if (!result.ok) return result;
  const { delivery } = result;
  return { ok: true, delivery: { deliveryId: delivery.id, leaseExpiresAt: delivery.lease_expires_at } };
}
