// Only a Workspace User can request ledger-driven projection repair.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import { userSession } from "../auth/user-session.ts";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { runParams } from "../runs/create-run-input.ts";
import { migrationErrorResponse } from "./preview-migration-input.ts";
import type { MigrationProjection } from "./migration-projection.ts";
import { rebuildMigrationProjection } from "./rebuild-migration-projection.ts";
import { rebuildMigrationProjectionInput, rebuildMigrationProjectionResponse } from "./rebuild-migration-projection-input.ts";
export function rebuildMigrationProjectionRoute(pool: Pool, auth: Auth, authUrl: string, projection?: MigrationProjection) {
  return new Elysia({ name: "rebuild-migration-projection" }).use(userSession(auth, authUrl)).post(
    "/api/v1/workspaces/:workspaceId/migrations/projection", async ({ user, params, status }) => {
      const result = await rebuildMigrationProjection(pool, { workspaceId: params.workspaceId, userId: user.id }, projection);
      return result.ok ? result.response : status(result.status, { error: result.error });
    }, {
      user: true, params: runParams, body: rebuildMigrationProjectionInput,
      transform({ request, body, set, status }) {
        set.headers["cache-control"] = "no-store";
        if (request.headers.has("authorization") || request.headers.has("x-backplane-run")) throw status(403, { error: "projection_forbidden" });
        if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).length) throw status(422, { error: "invalid_input" });
      },
      response: { 200: rebuildMigrationProjectionResponse, 400: migrationErrorResponse, 401: migrationErrorResponse,
        403: migrationErrorResponse, 422: migrationErrorResponse, 409: migrationErrorResponse, 503: migrationErrorResponse },
      error({ code, status }) { return code === "PARSE" ? status(400, { error: "invalid_request" }) : validationError({ code }); },
      detail: { "x-backplane-auth": "user", "x-backplane-run": "forbidden", operationId: "rebuildMigrationProjection", tags: ["schema"] },
    });
}
