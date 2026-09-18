// Blob adapters return decisions; HTTP status selection belongs to their routes.
export type BlobResult<T> = { ok: true; value: T } | { ok: false; error: string };
export function blobError(error: unknown): Extract<BlobResult<never>, { ok: false }> {
  const reason = error instanceof Error ? error.name === "TimeoutError" ? "blob_timeout" : error.message : "";
  if (["run_required", "run_invalid", "run_forbidden", "workspace_forbidden", "blob_forbidden", "blob_not_found", "blob_timeout",
    "blob_expired", "blob_too_large", "invalid_input", "blob_hash_mismatch"].includes(reason)) return { ok: false, error: reason };
  if (error instanceof Error && "errno" in error && error.errno === "23505") return { ok: false, error: "blob_key_conflict" };
  return { ok: false, error: "blob_unavailable" };
}
