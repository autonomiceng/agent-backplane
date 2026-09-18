// Send owns a transaction for HTTP; sendMessageIn joins a bound transaction for atomic handoffs.
import { quotaAccounting, QuotaExceeded, type QuotaFailure } from "../platform/quotas.ts";
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext, type EmitAudit, type RunTransaction } from "../runs/with-run-context.ts";
import { emitDeliveryEvents, type DeliveryResult } from "./delivery-result.ts";
import { queueError, type QueueError } from "./queue-error.ts";
import type { Message, SendMessageInput } from "./send-message-input.ts";

export async function sendMessageIn(tx: RunTransaction, emit: EmitAudit, workspaceId: string, queue: string, input: SendMessageInput): Promise<
  { message: Message; inserted: boolean }
> {
  // The text cast makes JSON null and scalar strings unambiguous to Bun's parameter encoder.
  const [row] = await tx<(Omit<Message, "createdAt"> & { createdAt: Date; inserted: boolean; bytes: number })[]>`
    SELECT (s.message).id, (s.message).workspace_id AS "workspaceId", (s.message).queue,
      (s.message).idempotency_key AS "idempotencyKey", (s.message).producer_principal_id AS "producerPrincipalId",
      (s.message).producer_run_id AS "producerRunId", (s.message).created_at AS "createdAt", s.inserted, s.bytes
    FROM queue.send_message(${workspaceId}, ${queue}, ${input.idempotencyKey}, ${JSON.stringify(input.payload)}::text::jsonb) s`;
  if (!row) throw new Error("queue_unavailable");
  const { inserted, bytes, ...message } = row;
  if (inserted) await emit("queue.send", [queue, message.id], 1, { idempotency_key_present: true, bytes });
  const [delivery] = await tx<{ result: DeliveryResult }[]>`SELECT queue.ensure_delivery(${workspaceId}, ${message.id}) AS result`;
  if (!delivery) throw new Error("queue_unavailable");
  await emitDeliveryEvents(emit, delivery.result);
  return { message: { ...message, createdAt: message.createdAt.toISOString() }, inserted };
}

export async function sendMessage(pool: Pool, context: Extract<RunContext, { principalId: string }>, queue: string, input: SendMessageInput): Promise<
  { ok: true; message: Message; inserted: boolean } | { ok: false; reason: QueueError; quota?: QuotaFailure }
> {
  try {
    const result = await withRunContext(pool, context, async (tx, emit) => {
      const quota = await quotaAccounting(tx, context);
      const result = await sendMessageIn(tx, emit, context.workspaceId, queue, input);
      quota.add("queue_sends", result.inserted ? 1 : 0);
      await quota.commit();
      return result;
    });
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof QuotaExceeded) {
      await recordRejection(pool, { context, kind: "queue.send", objects: [queue], reason: "quota_exceeded", sqlstate: null });
      return { ok: false, reason: "queue_unavailable", quota: error.body };
    }
    const failure = queueError(error);
    await recordRejection(pool, { context, kind: "queue.send", objects: [queue], ...failure });
    return { ok: false, reason: failure.reason };
  }
}
