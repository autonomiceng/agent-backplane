// User mutations bind attribution and membership before entering the storage definer.
import { approvalMember } from "../auth/decision-session.ts";
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { retentionError, type RetentionFailure } from "./retention-error.ts";
import type { setRetentionInput } from "./set-retention-input.ts";

export async function setRetention(pool: Pool, context: Extract<RunContext, { userId: string }>, seconds: number): Promise<
  { ok: true; value: typeof setRetentionInput.static } | RetentionFailure
> {
  try {
    const value = await withRunContext(pool, context, async (tx, emit) => {
      await approvalMember(tx, context);
      await tx`SELECT queue.set_retention(${context.workspaceId},${seconds})`;
      await emit("retention.updated", [], 1, { seconds });
      return { seconds };
    });
    return { ok: true, value };
  } catch (error) {
    const failure = retentionError(error);
    await recordRejection(pool, { context, kind: "retention.updated", objects: [], reason: failure.error, sqlstate: null });
    return failure;
  }
}
