// Reads scoped Message metadata and stored payload without advancing PGMQ visibility or read counters.
import type { Pool } from "../platform/pool.ts";
import type { MessageWithPayload } from "./get-message-input.ts";
import { queueError, type QueueError } from "./queue-error.ts";

export async function getMessage(pool: Pool, workspaceId: string, queue: string, messageId: string): Promise<
  { ok: true; message: MessageWithPayload } | { ok: false; reason: QueueError | "message_not_found" }
> {
  try {
    const [row] = await pool<(Omit<MessageWithPayload, "createdAt" | "payload"> & { createdAt: Date; payload: string | null })[]>`
      SELECT id, workspace_id AS "workspaceId", queue, idempotency_key AS "idempotencyKey",
        producer_principal_id AS "producerPrincipalId", producer_run_id AS "producerRunId", created_at AS "createdAt",
        queue.payload(workspace_id, queue, id)::text AS payload
      FROM queue.messages WHERE workspace_id = ${workspaceId} AND queue = ${queue} AND id = ${messageId}`;
    if (!row || row.payload === null) return { ok: false, reason: "message_not_found" };
    const payload: unknown = JSON.parse(row.payload);
    return { ok: true, message: { ...row, payload, createdAt: row.createdAt.toISOString() } };
  } catch (error) {
    return { ok: false, reason: queueError(error).reason };
  }
}
