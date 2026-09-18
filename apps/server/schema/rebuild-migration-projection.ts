// The User request is committed to audit before any projection filesystem work.
import type { Pool } from "../platform/pool.ts";
import { queryWorkspaceAccess } from "../auth/workspace-access-query.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { MigrationProjection, ProjectionResult } from "./migration-projection.ts";
class ProjectionDenied extends Error {}
export async function rebuildMigrationProjection(pool: Pool, context: Extract<RunContext, { userId: string }>, projection?: MigrationProjection,
  logger: Pick<Console, "error"> = console): Promise<ProjectionResult> {
  try {
    await withRunContext(pool, context, async (tx, emit) => {
      if (!(await queryWorkspaceAccess(tx, context.userId, context.workspaceId)).allowed) throw new ProjectionDenied("workspace_forbidden");
      await emit("migration.projection_requested", [], 0, {});
    });
  } catch (error) {
    if (error instanceof ProjectionDenied) {
      await recordRejection(pool, { context, kind: "migration.projection_requested", objects: [], reason: error.message, sqlstate: null });
      return { ok: false, status: 403, error: "workspace_forbidden" };
    }
    logger.error({ ...context, stage: "request", error: "projection_unavailable" });
    return { ok: false, status: 503, error: "projection_unavailable" };
  }
  return projection ? projection.project(context).catch(() => ({ ok: false, status: 503, error: "projection_unavailable" }))
    : { ok: false, status: 503, error: "projection_unavailable" };
}
