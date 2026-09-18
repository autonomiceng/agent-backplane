// Creates a Principal's Run and its envelope atomically through the restricted bootstrap path.
import type { PrincipalIdentity } from "../auth/principal-key.ts";
import type { Pool } from "../platform/pool.ts";
import type { NewRun, Run } from "./create-run-input.ts";
import { jsonObject } from "../events/read-audit-input.ts";
import { withRunContext } from "./with-run-context.ts";

export async function createRun(pool: Pool, principal: PrincipalIdentity, input: NewRun): Promise<
  { ok: true; run: Run } | { ok: false; reason: "principal_revoked" | "run_forbidden" | "run_creation_failed" }
> {
  try {
    const run = await withRunContext(pool, principal, async (tx, emit, runId) => {
      const [row] = await tx<(Omit<Run, "createdAt" | "lastSeenAt" | "metadata"> & {
        createdAt: Date; lastSeenAt: Date; metadata: unknown;
      })[]>`SELECT id, workspace_id AS "workspaceId", principal_id AS "principalId", harness, model, label,
        metadata, created_at AS "createdAt", last_seen_at AS "lastSeenAt" FROM control.runs WHERE id = ${runId}`;
      if (!row) throw new Error("run_creation_failed");
      await emit("runs.created", [row.id], 1, {});
      return { ...row, metadata: jsonObject(row.metadata),
        createdAt: row.createdAt.toISOString(), lastSeenAt: row.lastSeenAt.toISOString() };
    }, { newRun: input });
    return { ok: true, run };
  } catch (error) {
    const reason = error instanceof Error && (error.message === "principal_revoked" || error.message === "run_forbidden")
      ? error.message : "run_creation_failed";
    return { ok: false, reason };
  }
}
