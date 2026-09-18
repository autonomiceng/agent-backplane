// Adapters call this after rollback on the pool, outside the failed transaction.
// A process crash between rollback and this insert loses the attempt; v1 accepts that limit.
// reason is a stable code, never a raw error message.
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "./run-context.ts";

export type RejectionInput = {
  context: RunContext | null;
  kind: string;
  objects: string[];
  reason: string;
  sqlstate: string | null;
};

const CODE = /^[a-z][a-z0-9_.]*$/;
const OBJECT = /^[a-z0-9_.-]+$/i;

export async function recordRejection(pool: Pool, input: RejectionInput): Promise<{ recorded: boolean }> {
  const { context, kind, objects, reason, sqlstate } = input;
  if (!CODE.test(kind) || !CODE.test(reason) || objects.some((object) => !OBJECT.test(object))) return { recorded: false };
  try {
    await pool.begin(async (tx) => {
      await tx`SET LOCAL statement_timeout = 2000`;
      await tx`SET LOCAL lock_timeout = 2000`;
      await tx`INSERT INTO audit.rejections (workspace_id, principal_id, run_id, user_id, kind, objects, reason, sqlstate)
        VALUES (${context?.workspaceId ?? null},
          ${context && "principalId" in context ? context.principalId : null},
          ${context && "runId" in context ? context.runId : null},
          ${context && "userId" in context ? context.userId : null},
          ${kind}, ${tx.array(objects, "TEXT")}, ${reason}, ${sqlstate})`;
    });
    return { recorded: true };
  } catch {
    return { recorded: false };
  }
}
