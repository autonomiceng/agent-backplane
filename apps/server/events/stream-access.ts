// Resolves the original stream credential; snapshot authorization uses ordinary reads without Run context.
import type { SQL } from "bun";
import type { Auth } from "../auth/auth.ts";
import { parsePrincipalKey } from "../auth/principal-key.ts";
import { hashPrincipalSecret } from "../auth/principal-key-crypto.ts";
import type { Pool } from "../platform/pool.ts";

export type StreamAccess = { kind: "principal"; prefix: string; secretHash: Buffer }
  | { kind: "user"; userId: string; sessionId: string; token: string };

export async function resolveStreamAccess(auth: Auth, headers: Headers): Promise<StreamAccess | null> {
  if (headers.has("authorization")) {
    const key = parsePrincipalKey(headers.get("authorization"));
    return key ? { kind: "principal", prefix: key.prefix, secretHash: hashPrincipalSecret(key.secret) } : null;
  }
  const session = await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } });
  return session ? { kind: "user", userId: session.user.id, sessionId: session.session.id, token: session.session.token } : null;
}

export function streamAccessQuery(pool: Pool, access: StreamAccess, workspaceId: string): SQL.Query<unknown> {
  return access.kind === "principal" ? pool`
    SELECT CASE WHEN k.principal_id IS NULL THEN 'unauthorized'
      WHEN k.workspace_id <> ${workspaceId}::uuid THEN 'workspace_forbidden' END AS denied,
      'principal:' || k.principal_id::text AS actor
    FROM (SELECT 1) seed LEFT JOIN (
      SELECT k.principal_id, k.workspace_id FROM control.principal_keys k
      JOIN control.principals p ON p.workspace_id = k.workspace_id AND p.id = k.principal_id
      WHERE k.prefix = ${access.prefix} AND k.secret_hash = ${access.secretHash}
        AND k.revoked_at IS NULL AND p.status = 'active'
    ) k ON true` : pool`
    SELECT CASE WHEN NOT EXISTS (
      SELECT FROM control.session s WHERE s.id = ${access.sessionId} AND s.token = ${access.token}
        AND s."userId" = ${access.userId} AND s."expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
    ) THEN 'unauthorized' WHEN NOT EXISTS (
      SELECT FROM control.workspaces w JOIN control.member m ON m."organizationId" = w.organization_id
      WHERE w.id = ${workspaceId}::uuid AND m."userId" = ${access.userId}
    ) THEN 'workspace_forbidden' END AS denied, ${`user:${access.userId}`}::text AS actor`;
}
