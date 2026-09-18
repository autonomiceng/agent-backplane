// User-authored revocation changes Principal and credential together; a repeated call emits nothing.
import { pauseEffectsIn } from "../queue/pause-effects.ts";
import type { Pool } from "../platform/pool.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { queryWorkspaceAccess } from "./workspace-access-query.ts";

export type RevokePrincipalResult = { ok: true; principal: { principalId: string; workspaceId: string; status: "revoked"; effectsPausedThisRequest: number } }
  | { ok: false; reason: "workspace_forbidden" | "principal_not_found" | "principal_revocation_failed" };

class RevokePrincipalError extends Error {
  constructor(readonly reason: "workspace_forbidden" | "principal_not_found") { super(reason); }
}

export async function revokePrincipal(pool: Pool, userId: string, workspaceId: string, principalId: string): Promise<RevokePrincipalResult> {
  const context = { workspaceId, userId };
  let result: RevokePrincipalResult;
  try {
    result = await withRunContext(pool, context, async (tx, emit): Promise<RevokePrincipalResult> => {
      const access = await queryWorkspaceAccess(tx, userId, workspaceId);
      if (!access.allowed) throw new RevokePrincipalError(access.reason);
      const [principal] = await tx<{ status: string }[]>`
        SELECT status FROM control.principals WHERE workspace_id = ${workspaceId} AND id = ${principalId} AND system IS NULL`;
      if (!principal) throw new RevokePrincipalError("principal_not_found");
      let effectsPausedThisRequest = 0;
      if (principal.status !== "revoked") {
        await tx`UPDATE control.principals SET status = 'revoked' WHERE workspace_id = ${workspaceId} AND id = ${principalId}`;
        await tx`UPDATE control.principal_keys SET revoked_at = clock_timestamp() WHERE workspace_id = ${workspaceId} AND principal_id = ${principalId}`;
        await emit("principal.revoked", [principalId], 1, {});
        effectsPausedThisRequest = await pauseEffectsIn(tx, emit, workspaceId, principalId);
      }
      return { ok: true, principal: { principalId, workspaceId, status: "revoked", effectsPausedThisRequest } };
    });
  } catch (error) {
    result = { ok: false, reason: error instanceof RevokePrincipalError ? error.reason : "principal_revocation_failed" };
  }
  if (!result.ok) await recordRejection(pool, { context, kind: "principal.revoked", objects: [principalId], reason: result.reason, sqlstate: null });
  return result;
}
