// Creates a Workspace for a member of the seeded Organization and emits its first User-stamped event.
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import { queryWorkspaceAccess } from "./workspace-access-query.ts";
import { withRunContext } from "../runs/with-run-context.ts";

export type Workspace = { id: string; organizationId: string; name: string; createdAt: string };
export type CreateWorkspaceResult = { ok: true; workspace: Workspace } | { ok: false; reason: "workspace_forbidden" | "workspace_creation_failed" };

class WorkspaceForbidden extends Error {}

export async function createWorkspace(pool: Pool, userId: string, name: string): Promise<CreateWorkspaceResult> {
  const id = crypto.randomUUID();
  const context = { workspaceId: id, userId };
  try {
    return await withRunContext(pool, context, async (tx, emit) => {
      const access = await queryWorkspaceAccess(tx, userId, null);
      if (!access.allowed) throw new WorkspaceForbidden(access.reason);
      const [workspace] = await tx<{ id: string; organizationId: string; name: string; createdAt: Date }[]>`
        INSERT INTO control.workspaces (id, organization_id, name) VALUES (${id}, 'default', ${name.trim()})
        RETURNING id, organization_id AS "organizationId", name, created_at AS "createdAt"`;
      if (!workspace) throw new Error("workspace_creation_failed");
      await emit("workspace.created", [id], 1, {});
      return { ok: true, workspace: { ...workspace, createdAt: workspace.createdAt.toISOString() } };
    });
  } catch (error) {
    if (error instanceof WorkspaceForbidden) {
      await recordRejection(pool, { context, kind: "workspace.created", objects: [], reason: "workspace_forbidden", sqlstate: null });
      return { ok: false, reason: "workspace_forbidden" };
    }
    return { ok: false, reason: "workspace_creation_failed" };
  }
}
