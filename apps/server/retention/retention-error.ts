// Adapters classify storage failures without exposing database error details.
export type RetentionFailure = { ok: false; status: 403 | 404 | 408 | 410 | 503; error: string };

export function retentionError(error: unknown): RetentionFailure {
  const reason = error instanceof Error ? error.message : "";
  if (reason === "payload_expired") return { ok: false, status: 410, error: reason };
  if (reason === "audit_event_not_found" || reason === "payload_not_captured") return { ok: false, status: 404, error: reason };
  if (reason === "workspace_forbidden" || reason === "retention_forbidden") return { ok: false, status: 403, error: reason };
  if (typeof error === "object" && error !== null && "errno" in error
    && (error.errno === "57014" || error.errno === "55P03" || error.errno === "25P04")) return { ok: false, status: 408, error: "retention_timeout" };
  return { ok: false, status: 503, error: reason === "payload_read_failed" ? reason : "retention_unavailable" };
}
