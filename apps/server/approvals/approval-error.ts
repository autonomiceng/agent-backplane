// Approval adapters classify SQL failures; routes map the stable codes to HTTP statuses.
const statuses = {
  unauthorized: 401, workspace_forbidden: 403, run_forbidden: 403, approval_forbidden: 403,
  approval_self_forbidden: 403, receipt_foreign: 403, approval_not_found: 404,
  delivery_not_found: 404, principal_not_found: 404, approval_decided: 409,
  approval_expired: 409, approval_stale: 409, approval_exists: 409, receipt_stale: 409,
  receipt_expired: 409, delivery_conflict: 409, payload_expired: 410, invalid_input: 422,
  approval_required: 422, approval_target_unsupported: 422, approval_gate_conflict: 422,
  approval_target_not_found: 404, approval_gate_not_found: 404, approval_consumed: 409,
  approval_not_approved: 409, approval_mismatch: 409,
  approval_unavailable: 503, queue_unavailable: 503,
} satisfies Record<string, 401 | 403 | 404 | 409 | 410 | 422 | 503>;
export type ApprovalError = keyof typeof statuses;
export type ApprovalFailure = { reason: ApprovalError; sqlstate: string | null };
export type ApprovalErrorStatus = typeof statuses[ApprovalError];
export function approvalError(error: unknown): ApprovalFailure {
  const sqlstate = typeof error === "object" && error !== null && "errno" in error && typeof error.errno === "string" ? error.errno : null;
  if (error instanceof Error) {
    if (error.message === "principal_revoked") return { reason: "unauthorized", sqlstate };
    if (isApprovalError(error.message)) return { reason: error.message, sqlstate };
  }
  if (sqlstate === "23505" && typeof error === "object" && error !== null
    && "constraint" in error && error.constraint === "approvals_target_unique") return { reason: "approval_exists", sqlstate };
  if (["23514", "23502", "22P02", "22P05", "22021"].includes(sqlstate ?? "")) return { reason: "invalid_input", sqlstate };
  return { reason: "approval_unavailable", sqlstate };
}
function isApprovalError(reason: string): reason is ApprovalError { return Object.hasOwn(statuses, reason); }
export function approvalErrorStatus(reason: ApprovalError): ApprovalErrorStatus { return statuses[reason]; }
