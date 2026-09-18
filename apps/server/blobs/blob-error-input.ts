// Shared HTTP failures; routes translate adapter reasons into statuses.
import { t } from "elysia";
const error = t.Object({ error: t.String() });
export const blobFailures = { 400: error, 401: error, 403: error, 404: error, 408: error, 409: error, 410: error, 413: error, 422: error, 503: error };
export function blobStatus(reason: string): number {
  const codes = { run_required: 400, run_invalid: 400, run_forbidden: 403, workspace_forbidden: 403, blob_forbidden: 403,
    blob_not_found: 404, blob_timeout: 408, blob_key_conflict: 409, blob_expired: 410, blob_too_large: 413, invalid_input: 422, blob_hash_mismatch: 422 };
  for (const [name, status] of Object.entries(codes)) if (reason === name) return status;
  return 503;
}
