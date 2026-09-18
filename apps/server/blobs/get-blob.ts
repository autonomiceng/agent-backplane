// Read adapter verifies bytes and rechecks committed metadata and expiry before the route sends headers.
import type { Pool } from "../platform/pool.ts";
import { blobError, type BlobResult } from "./blob-result.ts";
import { blobMetadata } from "./blob-metadata.ts";
import { blobHash, type BlobStore } from "./blob-store.ts";
export async function getBlob(pool: Pool, workspace: string, id: string, store?: BlobStore): Promise<BlobResult<{ bytes: Uint8Array; contentType: string }>> {
  if (!store) return { ok: false, error: "blob_unavailable" };
  try {
    const row = await blobMetadata(pool, workspace, id);
    if (!row) return { ok: false, error: "blob_not_found" };
    if (row.expired) return { ok: false, error: "blob_expired" };
    const bytes = await store.open(workspace, id);
    if (bytes.length !== row.size || blobHash(bytes) !== row.sha256) return { ok: false, error: "blob_unavailable" };
    const current = await blobMetadata(pool, workspace, id);
    if (!current) return { ok: false, error: "blob_not_found" };
    if (current.expired) return { ok: false, error: "blob_expired" };
    return { ok: true, value: { bytes, contentType: current.content_type } };
  } catch (error) { return blobError(error); }
}
