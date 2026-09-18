// Reads historical and current Deliveries; cursor timestamps retain PostgreSQL microseconds.
import type { Pool } from "../platform/pool.ts";
import { serializeDelivery, type DeliveryEnvelopeRow } from "./delivery-envelope.ts";
import type { ListDeliveries, ListDeliveriesInput } from "./list-deliveries-input.ts";
import { queueError, type QueueError } from "./queue-error.ts";

function decodeCursor(after: string, workspaceId: string, queue: string, state: string | null) {
  try {
    const value: unknown = JSON.parse(Buffer.from(after, "base64url").toString("utf8"));
    if (typeof value !== "object" || value === null
      || !("workspaceId" in value) || value.workspaceId !== workspaceId
      || !("queue" in value) || value.queue !== queue
      || !("state" in value) || value.state !== state
      || !("createdAt" in value) || typeof value.createdAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.createdAt)
      || !Number.isFinite(Date.parse(value.createdAt))
      || new Date(value.createdAt).toISOString().slice(0, 19) !== value.createdAt.slice(0, 19)
      || !("id" in value) || typeof value.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id)) return null;
    return { createdAt: value.createdAt, id: value.id };
  } catch { return null; }
}

export async function listDeliveries(pool: Pool, workspaceId: string, queue: string, input: ListDeliveriesInput): Promise<
  { ok: true; page: ListDeliveries } | { ok: false; reason: QueueError }
> {
  const scope = { workspaceId: workspaceId.toLowerCase(), queue, state: input.state ?? null };
  const cursor = input.after === undefined ? null : decodeCursor(input.after, scope.workspaceId, queue, scope.state);
  if (input.after !== undefined && cursor === null) return { ok: false, reason: "invalid_input" };
  try {
    const [exists] = await pool`SELECT name FROM queue.queues WHERE workspace_id = ${workspaceId} AND name = ${queue}`;
    if (!exists) return { ok: false, reason: "queue_not_found" };
    const limit = input.limit ?? 50;
    const rows = await pool<{ envelope: DeliveryEnvelopeRow; createdAt: string }[]>`
      SELECT envelope, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"
      FROM queue.delivery_envelopes
      WHERE workspace_id = ${workspaceId} AND queue = ${queue}
        AND (${scope.state}::text IS NULL OR state = ${scope.state})
        AND (${cursor?.createdAt ?? null}::timestamptz IS NULL
          OR (created_at, id) > (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
      ORDER BY created_at, id LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = rows.length > limit && last
      ? Buffer.from(JSON.stringify({ ...scope, createdAt: last.createdAt, id: last.envelope.id })).toString("base64url") : null;
    return { ok: true, page: { items: items.map((row) => serializeDelivery(row.envelope)), nextCursor } };
  } catch (error) {
    return { ok: false, reason: queueError(error).reason };
  }
}
