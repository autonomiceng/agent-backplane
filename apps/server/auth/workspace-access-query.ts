// Locks the membership row for tenancy writes; Workspaces have no delete path in v1, so only membership can race. A null Workspace selects the seeded Organization for Workspace creation.
import type { Pool } from "../platform/pool.ts";
import type { RunTransaction } from "../runs/with-run-context.ts";
import { workspaceAccess } from "./workspace-access.ts";

export async function queryWorkspaceAccess(tx: Pool | RunTransaction, userId: string, workspaceId: string | null): Promise<ReturnType<typeof workspaceAccess>> {
  const rows = workspaceId === null
    ? await tx<{ organizationId: string }[]>`
      SELECT m."organizationId" FROM control.member m
      WHERE m."organizationId" = 'default' AND m."userId" = ${userId} FOR SHARE OF m`
    : await tx<{ organizationId: string }[]>`
      SELECT w.organization_id AS "organizationId" FROM control.workspaces w JOIN control.member m
        ON m."organizationId" = w.organization_id AND m."userId" = ${userId}
      WHERE w.id = ${workspaceId} FOR SHARE OF m`;
  return workspaceAccess({
    organizationId: rows[0]?.organizationId ?? null,
    memberships: rows.map((row) => ({ organizationId: row.organizationId, revoked: false })),
  });
}
