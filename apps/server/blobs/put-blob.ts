// Upload adapter buffers before binding, promotes before commit, and resolves uncertain commits before cleanup.
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import { blobError, type BlobResult } from "./blob-result.ts";
import type { blobResponse } from "./put-blob-input.ts";
import { blobHash, bufferBlob, type BlobStore } from "./blob-store.ts";
import { sweepBlobs } from "./sweep-blobs.ts";
import { blobMetadata } from "./blob-metadata.ts";
export async function putBlob(pool: Pool, context: RunContext, store: BlobStore | undefined, key: string, request: Request): Promise<BlobResult<typeof blobResponse.static>> {
  if (!store) return { ok: false, error: "blob_unavailable" };
  if (request.headers.get("content-type")?.toLowerCase() !== "application/octet-stream") return { ok: false, error: "invalid_input" };
  const buffered = await bufferBlob(request.body);
  if (!buffered.ok) return buffered;
  const bytes = buffered.value, expected = request.headers.get("x-backplane-sha256");
  if (expected !== null && expected !== blobHash(bytes)) return { ok: false, error: "blob_hash_mismatch" };
  const id = crypto.randomUUID(), hash = blobHash(bytes), workspace = context.workspaceId;
  try {
    const row = await withRunContext(pool, context, async (tx, emit) => {
      await sweepBlobs(tx, emit, workspace, store);
      await store.stage(workspace, id, bytes);
      await tx`INSERT INTO control.blobs(workspace_id,id,key,size,sha256,content_type)
        VALUES(${workspace},${id},${key},${bytes.length},${Buffer.from(hash, "hex")},'application/octet-stream')`;
      await emit("blob.put", [id], 1, { size: bytes.length });
      await store.promote(workspace, id, bytes);
      const verified = await store.open(workspace, id);
      if (verified.length !== bytes.length || blobHash(verified) !== hash) throw new Error("blob_unavailable");
      const row = await blobMetadata(tx, workspace, id);
      if (!row) throw new Error("blob_unavailable");
      return row;
    });
    const { expired: _expired, ...value } = row;
    return { ok: true, value };
  } catch (error) {
    const committed = await withRunContext(pool, context, async (tx, emit) => {
      const row = await blobMetadata(tx, workspace, id);
      if (!row) await sweepBlobs(tx, emit, workspace, store, [id]);
      return row;
    }).catch(() => undefined);
    if (committed) { const { expired: _expired, ...value } = committed; return { ok: true, value }; }
    await recordRejection(pool, { context, kind: "blob.put", objects: [id], reason: blobError(error).error, sqlstate: null });
    return blobError(error);
  }
}
