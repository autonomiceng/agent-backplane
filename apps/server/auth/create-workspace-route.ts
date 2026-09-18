// POST /api/v1/workspaces translates the authenticated User's creation result into the API contract.
import { Elysia, t } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "./auth.ts";
import { createWorkspace } from "./create-workspace.ts";
import { createWorkspaceInput, workspaceResponse } from "./create-workspace-input.ts";
import { userSession } from "./user-session.ts";
import { validationError } from "./validation-error.ts";

export function createWorkspaceRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "create-workspace" }).use(userSession(auth, authUrl)).post(
    "/api/v1/workspaces",
    async ({ user, body, status }) => {
      const result = await createWorkspace(pool, user.id, body.name);
      if (!result.ok) return result.reason === "workspace_forbidden"
        ? status(403, { error: result.reason })
        : status(503, { error: result.reason });
      return status(201, result.workspace);
    },
    {
      user: true,
      body: createWorkspaceInput,
      response: {
        201: workspaceResponse,
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "createWorkspace", tags: ["auth"] },
    },
  );
}
