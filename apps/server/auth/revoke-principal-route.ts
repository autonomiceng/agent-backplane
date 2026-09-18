// Translates the User's Principal revocation into the stable HTTP contract.
import { Elysia, t } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "./auth.ts";
import { principalKeyParams } from "./issue-principal-key-input.ts";
import { revokePrincipal } from "./revoke-principal.ts";
import { revokedPrincipalResponse } from "./revoke-principal-input.ts";
import { userSession } from "./user-session.ts";
import { validationError } from "./validation-error.ts";

export function revokePrincipalRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "revoke-principal" }).use(userSession(auth, authUrl)).post(
    "/api/v1/workspaces/:workspaceId/principals/:principalId/revoke",
    async ({ user, params, status }) => {
      const result = await revokePrincipal(pool, user.id, params.workspaceId, params.principalId);
      if (!result.ok) {
        if (result.reason === "workspace_forbidden") return status(403, { error: result.reason });
        if (result.reason === "principal_not_found") return status(404, { error: result.reason });
        return status(503, { error: result.reason });
      }
      return result.principal;
    },
    {
      user: true,
      params: principalKeyParams,
      response: {
        200: revokedPrincipalResponse,
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        404: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "revokePrincipal", tags: ["auth"] },
    },
  );
}
