// Approval adapters share a bound transaction and record sanitized rejections after rollback.
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import { withRunContext, type RunTransaction, type EmitAudit } from "../runs/with-run-context.ts";
import { approvalError, type ApprovalError } from "./approval-error.ts";

export type ApprovalResult<T> = { ok: true; value: T } | { ok: false; reason: ApprovalError };
export async function approvalWrite<T>(pool: Pool, context: RunContext, kind: string, objects: string[],
  fn: (tx: RunTransaction, emit: EmitAudit) => Promise<T>): Promise<ApprovalResult<T>> {
  try { return { ok: true, value: await withRunContext(pool, context, fn) }; }
  catch (error) {
    const failure = approvalError(error);
    await recordRejection(pool, { context, kind, objects, ...failure });
    return { ok: false, reason: failure.reason };
  }
}
