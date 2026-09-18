// Delete adapter resolves lost commit acknowledgements before reclaiming bytes in a separate bound transaction.
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { approvalMember } from "../auth/decision-session.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import { blobError, type BlobResult } from "./blob-result.ts";
import { blobMetadata } from "./blob-metadata.ts";
import type { BlobStore } from "./blob-store.ts";
import { cleanupBlobs } from "./sweep-blobs.ts";
export async function deleteBlob(pool: Pool, context: RunContext, id: string, store?: BlobStore): Promise<BlobResult<null>> {
  if (!store) return { ok: false, error: "blob_unavailable" };
  let readyToCommit = false;
  try {
    const result = await withRunContext(pool, context, async (tx, emit): Promise<BlobResult<null>> => {
      if ("userId" in context) await approvalMember(tx, context);
      const row = await blobMetadata(tx, context.workspaceId, id);
      if (!row) return { ok: false, error: "blob_not_found" };
      if ("principalId" in context && context.principalId !== row.principal_id) return { ok: false, error: "blob_forbidden" };
      await tx`DELETE FROM control.blobs WHERE workspace_id=${context.workspaceId} AND id=${id}`;
      await emit("blob.delete", [id], 1, {});
      readyToCommit = true;
      return { ok: true, value: null };
    });
    if (!result.ok) {
      await recordRejection(pool, { context, kind: "blob.delete", objects: [id], reason: result.error, sqlstate: null });
      return result;
    }
  } catch (error) {
    const deleted = readyToCommit && await withRunContext(pool, context, async (tx) => {
      if ("userId" in context) await approvalMember(tx, context);
      return !await blobMetadata(tx, context.workspaceId, id);
    }).catch(() => false);
    if (!deleted) {
      const failure = blobError(error);
      await recordRejection(pool, { context, kind: "blob.delete", objects: [id], reason: failure.error, sqlstate: null });
      return failure;
    }
  }
  await cleanupBlobs(pool, context, store, [id]);
  return { ok: true, value: null };
}
