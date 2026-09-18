// Discovers legacy Messages outside the cursor lock; ensure_delivery rechecks inside the bound transaction.
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { emitDeliveryEvents } from "./delivery-result.ts";
import type { RecoveryResult } from "./delivery-envelope.ts";
import { queueError, type QueueError } from "./queue-error.ts";
import type { Recover } from "./recover-input.ts";

export async function recover(pool: Pool, context: Extract<RunContext, { principalId: string }>, queue: string): Promise<
  { ok: true; recovery: Recover } | { ok: false; reason: QueueError }
> {
  try {
    const [exists] = await pool`SELECT name FROM queue.queues WHERE workspace_id = ${context.workspaceId} AND name = ${queue}`;
    if (!exists) throw new Error("queue_not_found");
    const candidates = await pool<{ id: string }[]>`
      SELECT m.id FROM queue.messages m
      WHERE m.workspace_id = ${context.workspaceId} AND m.queue = ${queue}
        AND NOT EXISTS (SELECT FROM queue.delivery_envelopes d
          WHERE d.workspace_id = m.workspace_id AND d.queue = m.queue AND d.envelope->>'message_id' = m.id::text)
      ORDER BY m.created_at, m.id LIMIT 32`;
    const recovery = await withRunContext(pool, context, async (tx, emit) => {
      let created = 0;
      for (const candidate of candidates) {
        const [row] = await tx<{ result: RecoveryResult }[]>`SELECT queue.ensure_delivery(${context.workspaceId}, ${candidate.id}) AS result`;
        if (!row) throw new Error("queue_unavailable");
        await emitDeliveryEvents(emit, row.result);
        if (row.result.data !== null) created++;
      }
      const [remaining] = await tx<{ hasMore: boolean }[]>`
        SELECT EXISTS (
          SELECT FROM queue.messages m
          WHERE m.workspace_id = ${context.workspaceId} AND m.queue = ${queue}
            AND NOT EXISTS (SELECT FROM queue.delivery_envelopes d
              WHERE d.workspace_id = m.workspace_id AND d.queue = m.queue AND d.envelope->>'message_id' = m.id::text)
        ) AS "hasMore"`;
      if (!remaining) throw new Error("queue_unavailable");
      return { created, hasMore: remaining.hasMore };
    });
    return { ok: true, recovery };
  } catch (error) {
    const failure = queueError(error);
    await recordRejection(pool, { context, kind: "queue.recover", objects: [queue], ...failure });
    return { ok: false, reason: failure.reason };
  }
}
