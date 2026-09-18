// Queue adapters expose stable failure codes and retain only SQLSTATE for rejection records.
export type QueueError = "restore_gated" | "reconciliation_forbidden" | "reconciliation_conflict" | "workspace_forbidden" | "principal_not_found" | "effect_key_conflict" | "principal_revoked" | "delivery_conflict" | "recovery_forbidden" | "payload_expired" | "queue_exists" | "queue_not_found" | "idempotency_conflict" | "payload_too_large" | "invalid_input" | "queue_unavailable" | "delivery_not_found" | "receipt_foreign" | "receipt_stale" | "receipt_expired";

export function queueError(error: unknown): { reason: QueueError; sqlstate: string | null } {
  const sqlstate = typeof error === "object" && error !== null && "errno" in error && typeof error.errno === "string" ? error.errno : null;
  if (error instanceof Error) {
    const reason = error.message;
    if (reason === "restore_gated" || reason === "reconciliation_forbidden" || reason === "reconciliation_conflict" || reason === "workspace_forbidden" || reason === "principal_not_found" || reason === "principal_revoked" || reason === "effect_key_conflict" || reason === "delivery_conflict" || reason === "recovery_forbidden" || reason === "payload_expired" || reason === "queue_exists" || reason === "queue_not_found" || reason === "idempotency_conflict"
      || reason === "delivery_not_found" || reason === "receipt_foreign" || reason === "receipt_stale" || reason === "receipt_expired"
      || reason === "payload_too_large" || reason === "invalid_input") return { reason, sqlstate };
  }
  if (sqlstate === "23505" && typeof error === "object" && error !== null
    && "constraint" in error && error.constraint === "queues_pkey") return { reason: "queue_exists", sqlstate };
  if (sqlstate === "23514" || sqlstate === "23502" || sqlstate === "22P02" || sqlstate === "22P05" || sqlstate === "22021") {
    return { reason: "invalid_input", sqlstate };
  }
  return { reason: "queue_unavailable", sqlstate };
}

export function queueErrorStatus(reason: QueueError): 403 | 404 | 409 | 410 | 413 | 422 | 503 {
  if (reason === "payload_expired") return 410;
  if (reason === "reconciliation_forbidden" || reason === "workspace_forbidden" || reason === "principal_revoked" || reason === "recovery_forbidden" || reason === "receipt_foreign") return 403;
  if (reason === "principal_not_found" || reason === "delivery_not_found" || reason === "queue_not_found") return 404;
  if (reason === "reconciliation_conflict" || reason === "effect_key_conflict" || reason === "delivery_conflict" || reason === "receipt_stale" || reason === "receipt_expired" || reason === "queue_exists" || reason === "idempotency_conflict") return 409;
  if (reason === "payload_too_large") return 413;
  if (reason === "invalid_input") return 422;
  return 503;
}
