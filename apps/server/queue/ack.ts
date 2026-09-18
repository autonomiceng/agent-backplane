// Ack exposes the Receipt-fenced transition to HTTP callers.
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import type { EmitAudit, RunTransaction } from "../runs/with-run-context.ts";
import type { Ack } from "./ack-input.ts";
import type { QueueError } from "./queue-error.ts";
import { receiptVerb, receiptVerbIn } from "./receipt-verb.ts";

// Atomic handoffs call this after binding their existing transaction.
export async function ackIn(tx: RunTransaction, emit: EmitAudit, workspaceId: string, deliveryId: string, receipt: string): Promise<Ack> {
  const delivery = await receiptVerbIn(tx, emit, workspaceId, deliveryId, receipt, "ack");
  return { deliveryId: delivery.id, state: delivery.state };
}

export async function ack(pool: Pool, context: Extract<RunContext, { principalId: string }>, deliveryId: string, receipt: string): Promise<
  { ok: true; delivery: Ack } | { ok: false; reason: QueueError }
> {
  const result = await receiptVerb(pool, context, deliveryId, receipt, "ack");
  if (!result.ok) return result;
  const { delivery } = result;
  return { ok: true, delivery: { deliveryId: delivery.id, state: delivery.state } };
}
