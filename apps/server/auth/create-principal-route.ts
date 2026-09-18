// POST /api/v1/workspaces/:workspaceId/principals translates membership and provisioning results.
import { Elysia, t } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "./auth.ts";
import { createPrincipal } from "./create-principal.ts";
import { createPrincipalInput, createPrincipalParams, principalResponse } from "./create-principal-input.ts";
import { userSession } from "./user-session.ts";
import { validationError } from "./validation-error.ts";

export function createPrincipalRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "create-principal" }).use(userSession(auth, authUrl)).post(
    "/api/v1/workspaces/:workspaceId/principals",
    async ({ user, body, params, status }) => {
      const result = await createPrincipal(pool, user.id, params.workspaceId, body.name);
      if (!result.ok) return result.reason === "workspace_forbidden"
        ? status(403, { error: result.reason })
        : status(503, { error: result.reason });
      return status(201, result.principal);
    },
    {
      user: true,
      body: createPrincipalInput,
      params: createPrincipalParams,
      response: {
        201: principalResponse,
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "createPrincipal", tags: ["auth"] },
    },
  );
}
