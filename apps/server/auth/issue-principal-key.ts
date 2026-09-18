// Issues or rotates the single credential under User context, serialized with Principal revocation.
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { generatePrincipalKey } from "./principal-key-crypto.ts";
import { queryWorkspaceAccess } from "./workspace-access-query.ts";

export type IssuedPrincipalKey = { key: string; prefix: string; createdAt: string; rotatedAt: string | null };
export type IssuePrincipalKeyResult = { ok: true; credential: IssuedPrincipalKey }
  | { ok: false; reason: "workspace_forbidden" | "principal_not_found" | "principal_revoked" | "principal_key_issue_failed" };

class IssuePrincipalKeyError extends Error {
  constructor(readonly reason: "workspace_forbidden" | "principal_not_found" | "principal_revoked") { super(reason); }
}

export async function issuePrincipalKey(pool: Pool, userId: string, workspaceId: string, principalId: string): Promise<IssuePrincipalKeyResult> {
  const context = { workspaceId, userId };
  let result: IssuePrincipalKeyResult;
  try {
    result = await withRunContext(pool, context, async (tx, emit): Promise<IssuePrincipalKeyResult> => {
      const access = await queryWorkspaceAccess(tx, userId, workspaceId);
      if (!access.allowed) throw new IssuePrincipalKeyError(access.reason);
      const [principal] = await tx<{ status: string }[]>`
        SELECT status FROM control.principals WHERE workspace_id = ${workspaceId} AND id = ${principalId}`;
      if (!principal) throw new IssuePrincipalKeyError("principal_not_found");
      if (principal.status !== "active") throw new IssuePrincipalKeyError("principal_revoked");
      const material = generatePrincipalKey();
      const [row] = await tx<{ createdAt: Date; rotatedAt: Date | null }[]>`
        INSERT INTO control.principal_keys (workspace_id, principal_id, prefix, secret_hash)
        VALUES (${workspaceId}, ${principalId}, ${material.prefix}, ${material.secretHash})
        ON CONFLICT (workspace_id, principal_id) DO UPDATE
          SET prefix = EXCLUDED.prefix, secret_hash = EXCLUDED.secret_hash, rotated_at = clock_timestamp(), last_used_at = NULL
        RETURNING created_at AS "createdAt", rotated_at AS "rotatedAt"`;
      if (!row) throw new Error("principal_key_issue_failed");
      await emit(row.rotatedAt ? "principal.key_rotated" : "principal.key_issued", [principalId], 1, { prefix: material.prefix });
      return { ok: true, credential: {
        key: material.key, prefix: material.prefix, createdAt: row.createdAt.toISOString(), rotatedAt: row.rotatedAt?.toISOString() ?? null,
      } };
    });
  } catch (error) {
    // The system_principal_credential trigger (migration 000028) refuses keys for system Principals; they are
    // invisible to this route, so answer as for an unknown id. The lookup stays schema-neutral for legacy fixtures.
    const systemPrincipal = error instanceof Error && error.message.includes("system_principal_credential_forbidden");
    result = { ok: false, reason: error instanceof IssuePrincipalKeyError ? error.reason : systemPrincipal ? "principal_not_found" : "principal_key_issue_failed" };
  }
  if (!result.ok) await recordRejection(pool, { context, kind: "principal.key_issued", objects: [principalId], reason: result.reason, sqlstate: null });
  return result;
}
