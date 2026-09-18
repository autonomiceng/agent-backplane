// Claim binds dispatch, Delivery leasing and every lazy expiry event in one transaction.
import { randomBytes } from "node:crypto";
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext, type EmitAudit, type RunTransaction } from "../runs/with-run-context.ts";
import type { Claim } from "./claim-input.ts";
import { emitDeliveryEvents, type DeliveryResult } from "./delivery-result.ts";
import { queueError, type QueueError } from "./queue-error.ts";
import { hashReceipt } from "./receipt-verb.ts";

export async function claimIn(tx: RunTransaction, emit: EmitAudit, workspaceId: string, queue: string): Promise<Claim | null> {
  const receipt = randomBytes(32).toString("base64url");
  const receiptHash = hashReceipt(receipt);
  const [row] = await tx<{ result: DeliveryResult }[]>`SELECT queue.claim(${workspaceId}, ${queue}, ${receiptHash}) AS result`;
  if (!row) throw new Error("queue_unavailable");
  await emitDeliveryEvents(emit, row.result);
  const { data, payload } = row.result;
  return data === null ? null : {
    deliveryId: data.id, messageId: data.message_id, attempt: data.attempt, receipt,
    leaseExpiresAt: data.lease_expires_at, payload,
  };
}

export async function claim(pool: Pool, context: Extract<RunContext, { principalId: string }>, queue: string): Promise<
  { ok: true; claim: Claim | null } | { ok: false; reason: QueueError }
> {
  try {
    const claimed = await withRunContext(pool, context, (tx, emit) => claimIn(tx, emit, context.workspaceId, queue));
    return { ok: true, claim: claimed };
  } catch (error) {
    const failure = queueError(error);
    await recordRejection(pool, { context, kind: "queue.claim", objects: [queue], ...failure });
    return { ok: false, reason: failure.reason };
  }
}
