// Locks Workspace membership, then provisions the role, Principal and Audit Event in one User-bound transaction.
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { queryWorkspaceAccess } from "./workspace-access-query.ts";

export type Principal = { id: string; workspaceId: string; name: string; roleName: string; status: "active" | "revoked"; createdAt: string };
export type CreatePrincipalResult = { ok: true; principal: Principal } | { ok: false; reason: "workspace_forbidden" | "principal_creation_failed" };

class WorkspaceForbidden extends Error {}

export async function createPrincipal(pool: Pool, userId: string, workspaceId: string, name: string): Promise<CreatePrincipalResult> {
  const id = crypto.randomUUID();
  const context = { workspaceId, userId };
  try {
    const principal = await withRunContext(pool, context, async (tx, emit) => {
      const access = await queryWorkspaceAccess(tx, userId, workspaceId);
      if (!access.allowed) throw new WorkspaceForbidden(access.reason);
      const [role] = await tx<{ name: string }[]>`SELECT control.create_principal_role(${workspaceId}, ${id}) AS name`;
      if (!role) throw new Error("principal_creation_failed");
      const [row] = await tx<(Omit<Principal, "createdAt"> & { createdAt: Date })[]>`
        INSERT INTO control.principals (id, workspace_id, name, role_name) VALUES (${id}, ${workspaceId}, ${name.trim()}, ${role.name})
        RETURNING id, workspace_id AS "workspaceId", name, role_name AS "roleName", status, created_at AS "createdAt"`;
      if (!row) throw new Error("principal_creation_failed");
      await emit("principal.created", [id], 1, {});
      return { ...row, createdAt: row.createdAt.toISOString() };
    });
    return { ok: true, principal };
  } catch (error) {
    if (error instanceof WorkspaceForbidden) {
      await recordRejection(pool, { context, kind: "principal.created", objects: [], reason: "workspace_forbidden", sqlstate: null });
      return { ok: false, reason: "workspace_forbidden" };
    }
    const sqlstate = typeof error === "object" && error !== null && "errno" in error && typeof error.errno === "string" ? error.errno : null;
    await recordRejection(pool, { context, kind: "principal.created", objects: [], reason: "principal_creation_failed", sqlstate });
    return { ok: false, reason: "principal_creation_failed" };
  }
}
