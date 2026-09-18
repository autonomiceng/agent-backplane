// Loads only ownership facts for the Run session's preflight check; bind_context remains authoritative.
import type { PrincipalIdentity } from "../auth/principal-key.ts";
import type { Pool } from "../platform/pool.ts";

export async function queryRunAccess(pool: Pool, runId: string): Promise<PrincipalIdentity | null> {
  const [row] = await pool<PrincipalIdentity[]>`
    SELECT workspace_id AS "workspaceId", principal_id AS "principalId" FROM control.runs WHERE id = ${runId}`;
  return row ?? null;
}
