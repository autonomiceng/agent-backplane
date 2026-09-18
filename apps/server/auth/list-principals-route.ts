// Exposes Workspace Principal metadata to authenticated Users.
import { Elysia, t } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "./auth.ts";
import { listPrincipals } from "./list-principals.ts";
import { listPrincipalsInput, listPrincipalsParams, listPrincipalsResponse } from "./list-principals-input.ts";
import { userSession } from "./user-session.ts";
import { validationError } from "./validation-error.ts";

export function listPrincipalsRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "list-principals" }).use(userSession(auth, authUrl)).get(
    "/api/v1/workspaces/:workspaceId/principals",
    async ({ user, params, query, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await listPrincipals(pool, user.id, params.workspaceId, query);
      if (!result.ok) {
        if (result.reason === "workspace_forbidden") return status(403, { error: result.reason });
        if (result.reason === "invalid_input") return status(422, { error: result.reason });
        return status(503, { error: result.reason });
      }
      return result.page;
    },
    {
      user: true, params: listPrincipalsParams, query: listPrincipalsInput,
      response: {
        200: listPrincipalsResponse,
        401: t.Object({ error: t.String() }), 403: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }), 503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "listPrincipals", tags: ["auth"] },
    },
  );
}
