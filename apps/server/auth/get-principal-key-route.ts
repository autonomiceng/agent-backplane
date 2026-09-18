// Users inspect credential metadata without retrieving the secret or its digest.
import { Elysia, t } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "./auth.ts";
import { principalKeyParams } from "./issue-principal-key-input.ts";
import { queryPrincipalKeyMetadata } from "./principal-key-query.ts";
import { userSession } from "./user-session.ts";
import { validationError } from "./validation-error.ts";

export function getPrincipalKeyRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "get-principal-key" }).use(userSession(auth, authUrl)).get(
    "/api/v1/workspaces/:workspaceId/principals/:principalId/keys",
    async ({ user, params, status }) => {
      const result = await queryPrincipalKeyMetadata(pool, user.id, params.workspaceId, params.principalId);
      if (!result.ok) {
        if (result.reason === "workspace_forbidden") return status(403, { error: result.reason });
        if (result.reason === "principal_not_found") return status(404, { error: result.reason });
        return status(503, { error: result.reason });
      }
      return result.credential;
    },
    {
      user: true,
      params: principalKeyParams,
      response: {
        200: t.Nullable(t.Object({
          prefix: t.String(),
          createdAt: t.String({ format: "date-time" }),
          rotatedAt: t.Nullable(t.String({ format: "date-time" })),
          lastUsedAt: t.Nullable(t.String({ format: "date-time" })),
          revokedAt: t.Nullable(t.String({ format: "date-time" })),
        })),
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        404: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error: validationError,
      mapResponse({ response }) {
        // Elysia maps a bare null to an empty body; the contract requires a JSON null.
        if (response === null) return Response.json(null);
      },
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "getPrincipalKey", tags: ["auth"] },
    },
  );
}
