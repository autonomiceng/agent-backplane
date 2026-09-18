// Loads credentials for the Principal session macro; never exposes stored hashes to HTTP responses.
import type { Pool } from "../platform/pool.ts";
import type { PrincipalKeyFacts } from "./principal-key.ts";
import { queryWorkspaceAccess } from "./workspace-access-query.ts";

export async function queryPrincipalKey(pool: Pool, prefix: string): Promise<(PrincipalKeyFacts & { secretHash: Uint8Array }) | null> {
  const [row] = await pool<(PrincipalKeyFacts & { secretHash: Uint8Array })[]>`
    SELECT k.principal_id AS "principalId", k.workspace_id AS "workspaceId", k.secret_hash AS "secretHash",
      k.revoked_at AS "revokedAt", p.status
    FROM control.principal_keys k JOIN control.principals p ON p.workspace_id = k.workspace_id AND p.id = k.principal_id
    WHERE k.prefix = ${prefix}`;
  return row ?? null;
}

export type PrincipalKeyMetadata = { prefix: string; createdAt: string; rotatedAt: string | null; lastUsedAt: string | null; revokedAt: string | null };
export type PrincipalKeyMetadataResult = { ok: true; credential: PrincipalKeyMetadata | null }
  | { ok: false; reason: "workspace_forbidden" | "principal_not_found" | "principal_key_query_failed" };

export async function queryPrincipalKeyMetadata(pool: Pool, userId: string, workspaceId: string, principalId: string): Promise<PrincipalKeyMetadataResult> {
  try {
    const access = await queryWorkspaceAccess(pool, userId, workspaceId);
    if (!access.allowed) return { ok: false, reason: access.reason };
    const [row] = await pool<{ prefix: string | null; createdAt: Date | null; rotatedAt: Date | null; lastUsedAt: Date | null; revokedAt: Date | null }[]>`
      SELECT k.prefix, k.created_at AS "createdAt", k.rotated_at AS "rotatedAt", k.last_used_at AS "lastUsedAt", k.revoked_at AS "revokedAt"
      FROM control.principals p LEFT JOIN control.principal_keys k ON k.workspace_id = p.workspace_id AND k.principal_id = p.id
      WHERE p.workspace_id = ${workspaceId} AND p.id = ${principalId} AND p.system IS NULL`;
    if (!row) return { ok: false, reason: "principal_not_found" };
    return { ok: true, credential: row.prefix === null || row.createdAt === null ? null : {
      prefix: row.prefix, createdAt: row.createdAt.toISOString(), rotatedAt: row.rotatedAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null, revokedAt: row.revokedAt?.toISOString() ?? null,
    } };
  } catch {
    return { ok: false, reason: "principal_key_query_failed" };
  }
}
