import { Elysia, t } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "./auth.ts";
import { listWorkspaces } from "./list-workspaces.ts";
import { listWorkspacesInput, listWorkspacesResponse } from "./list-workspaces-input.ts";
import { userSession } from "./user-session.ts";
import { validationError } from "./validation-error.ts";

export function listWorkspacesRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "list-workspaces" }).use(userSession(auth, authUrl)).get(
    "/api/v1/workspaces",
    async ({ user, query, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await listWorkspaces(pool, user.id, query);
      if (!result.ok) return result.reason === "invalid_input"
        ? status(422, { error: result.reason }) : status(503, { error: result.reason });
      return result.page;
    },
    {
      user: true, query: listWorkspacesInput,
      response: {
        200: listWorkspacesResponse, 401: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }), 503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "listWorkspaces", tags: ["auth"] },
    },
  );
}
