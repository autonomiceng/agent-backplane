// Routes sanitize adapter failures and record authenticated write rejections after rollback.
import type { RunTransaction } from "../runs/with-run-context.ts";
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { recordRejection } from "../runs/record-rejection.ts";
const statuses = { run_required: 400, run_invalid: 400, unauthorized: 401, workspace_forbidden: 403,
  run_forbidden: 403, function_forbidden: 403, origin_forbidden: 403, deployment_not_found: 404,
  deployment_conflict: 409, activation_conflict: 409, deployment_retired: 409, bundle_too_large: 413,
  invalid_input: 422, bundle_invalid: 422, compute_timeout: 408, compute_disabled: 503,
  compute_unavailable: 503, compute_quota_exceeded: 429 } satisfies Record<string, 400 | 401 | 403 | 404 | 408 | 409 | 413 | 422 | 429 | 503>;
export type ComputeFailure = { ok: false; reason: keyof typeof statuses };
export type ComputeResult<T> = { ok: true; value: T } | ComputeFailure;
export function computeFailure(reason: ComputeFailure["reason"]): ComputeFailure { return { ok: false, reason }; }
export function computeSuccess<T>(value: T): { ok: true; value: T } { return { ok: true, value }; }
// Callers return immediately: no query may run after this explicit transaction rollback.
export async function rollbackCompute(tx: RunTransaction, reason: ComputeFailure["reason"]): Promise<ComputeFailure> {
  await tx`ROLLBACK`;
  return computeFailure(reason);
}
function known(reason: string): reason is keyof typeof statuses { return Object.hasOwn(statuses, reason); }
export async function computeError(pool: Pool, error: unknown, context?: RunContext, kind = "", objects: string[] = []) {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const reason = known(message) ? message : message === "principal_revoked" ? "unauthorized" : "compute_unavailable";
  if (context) await recordRejection(pool, { context, kind, objects, reason,
    sqlstate: typeof error === "object" && error !== null && "errno" in error && typeof error.errno === "string" ? error.errno : null });
  return { code: statuses[reason], error: reason };
}
