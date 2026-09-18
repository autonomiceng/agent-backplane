// Authenticated HTTP inventory for the restore gate.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import { userSession } from "../auth/user-session.ts";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { restoreStatus } from "./restore-status.ts";
import { restoreErrors, restoreParams, restoreStatusResponse } from "./restore-status-input.ts";
export function restoreStatusRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "restore-status" }).use(userSession(auth, authUrl)).get("/api/v1/workspaces/:workspaceId/restore",
    async ({ user, params, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await restoreStatus(pool, user.id, params.workspaceId);
      return "error" in result ? status(result.error === "workspace_forbidden" ? 403 : 503, result) : result;
    }, { user: true, params: restoreParams, response: { 200: restoreStatusResponse, ...restoreErrors }, error: validationError,
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "restoreStatus", tags: ["restore"] } });
}
