// Creates dispatch storage and its Queue atomically with the Principal's bound Audit Event.
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import type { Queue } from "./create-queue-input.ts";
import { queueError, type QueueError } from "./queue-error.ts";

export async function createQueue(pool: Pool, context: Extract<RunContext, { principalId: string }>, name: string): Promise<
  { ok: true; queue: Queue } | { ok: false; reason: QueueError }
> {
  try {
    const queue = await withRunContext(pool, context, async (tx, emit) => {
      const [row] = await tx<(Omit<Queue, "createdAt"> & { createdAt: Date })[]>`
        SELECT workspace_id AS "workspaceId", name, created_at AS "createdAt"
        FROM queue.create_queue(${context.workspaceId}, ${name})`;
      if (!row) throw new Error("queue_unavailable");
      await emit("queue.created", [name], 1, {});
      return { ...row, createdAt: row.createdAt.toISOString() };
    });
    return { ok: true, queue };
  } catch (error) {
    const failure = queueError(error);
    await recordRejection(pool, { context, kind: "queue.created", objects: [name], ...failure });
    return { ok: false, reason: failure.reason };
  }
}
