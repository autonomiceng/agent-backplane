// Purge batches bind attribution before entering the storage definer; User requests also check membership.
import type { BlobStore } from "../blobs/blob-store.ts";
import { cleanupBlobs } from "../blobs/sweep-blobs.ts";
import { approvalMember } from "../auth/decision-session.ts";
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { retentionError, type RetentionFailure } from "./retention-error.ts";
import type { purgeResponse } from "./purge-payloads-input.ts";

export async function purgePayloads(pool: Pool, context: RunContext, limit: number, store?: BlobStore): Promise<
  { ok: true; value: typeof purgeResponse.static } | RetentionFailure
> {
  try {
    let ids: string[] = [];
    const value = await withRunContext(pool, context, async (tx, emit) => {
      if ("userId" in context) await approvalMember(tx, context);
      const [raw] = await tx<{ result: string }[]>`SELECT queue.purge_payloads(${context.workspaceId},${limit})::text AS result`;
      const row: { result: typeof purgeResponse.static } | undefined = raw ? { result: JSON.parse(raw.result) } : undefined;
      if (!row) throw new Error("retention_unavailable");
      const remaining = limit - Object.values(row.result.counts).reduce((sum, count) => sum + count, 0);
      const expired = await tx<{ id: string }[]>`SELECT id FROM control.blobs WHERE workspace_id=${context.workspaceId}
        AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT ${remaining + 1}`;
      ids = expired.slice(0, remaining).map((row) => row.id);
      for (const id of ids) {
        await tx`DELETE FROM control.blobs WHERE workspace_id=${context.workspaceId} AND id=${id}`;
        await emit("blob.delete", [id], 1, { reason: "expired" });
      }
      row.result.counts.blobs = ids.length; row.result.hasMore ||= expired.length > remaining;
      row.result.cleanupPending = false;
      await emit("retention.purged", [], Object.values(row.result.counts).reduce((sum, count) => sum + count, 0), row.result.counts);
      return row.result;
    });
    value.cleanupPending = await cleanupBlobs(pool, context, store, ids);
    value.cleanupPending = await cleanupBlobs(pool, context, store) || value.cleanupPending;
    return { ok: true, value };
  } catch (error) {
    const failure = retentionError(error);
    await recordRejection(pool, { context, kind: "retention.purged", objects: [], reason: failure.error, sqlstate: null });
    return failure;
  }
}
