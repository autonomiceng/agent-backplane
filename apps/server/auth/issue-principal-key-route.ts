// The User receives the plaintext credential once, in an uncacheable issue response.
import { Elysia, t } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "./auth.ts";
import { issuePrincipalKey } from "./issue-principal-key.ts";
import { issuedPrincipalKeyResponse, principalKeyParams } from "./issue-principal-key-input.ts";
import { userSession } from "./user-session.ts";
import { validationError } from "./validation-error.ts";

export function issuePrincipalKeyRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "issue-principal-key" }).use(userSession(auth, authUrl)).post(
    "/api/v1/workspaces/:workspaceId/principals/:principalId/keys",
    async ({ user, params, status, set }) => {
      const result = await issuePrincipalKey(pool, user.id, params.workspaceId, params.principalId);
      if (!result.ok) {
        if (result.reason === "workspace_forbidden") return status(403, { error: result.reason });
        if (result.reason === "principal_not_found") return status(404, { error: result.reason });
        if (result.reason === "principal_revoked") return status(409, { error: result.reason });
        return status(503, { error: result.reason });
      }
      set.headers["cache-control"] = "no-store";
      return status(201, result.credential);
    },
    {
      user: true,
      params: principalKeyParams,
      response: {
        201: issuedPrincipalKeyResponse,
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        404: t.Object({ error: t.String() }),
        409: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "issuePrincipalKey", tags: ["auth"] },
    },
  );
}
