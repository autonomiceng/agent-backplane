// HTTP release commits at most 100 restored Deliveries per request.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import { userSession } from "../auth/user-session.ts";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { releaseRestore } from "./release-restore.ts";
import { restoreErrors, restoreParams } from "./restore-status-input.ts";
import { releaseRestoreInput, releaseRestoreResponse } from "./release-restore-input.ts";
export function releaseRestoreRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "release-restore" }).use(userSession(auth, authUrl)).post("/api/v1/workspaces/:workspaceId/restore/release",
    async ({ user, params, body, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await releaseRestore(pool, user.id, params.workspaceId, body.epoch);
      if ("error" in result) return status(result.error === "workspace_forbidden" ? 403 : result.error === "restore_conflict" ? 409 : 503, result);
      return status(result.done ? 200 : 202, result);
    }, { user: true, params: restoreParams, body: releaseRestoreInput,
      response: { 200: releaseRestoreResponse, 202: releaseRestoreResponse, ...restoreErrors }, error: validationError,
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "releaseRestore", tags: ["restore"],
        description: "Assert sourceFenced only after confirming the old primary is stopped. Release fences every restored Delivery that could have been dispatched by invalidating its Receipt; begun Effects become ambiguous. Lost WAL can hide later Effects: source fencing cannot establish whether those external actions happened. Repeat 202 batches until complete." } });
}
