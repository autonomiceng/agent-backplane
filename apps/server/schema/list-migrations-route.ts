// Either authenticated actor can review its Workspace's immutable Migration ledger.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import { eitherSession } from "../auth/either-session.ts";
import type { Pool } from "../platform/pool.ts";
import { runParams } from "../runs/create-run-input.ts";
import { migrationErrorResponse } from "./preview-migration-input.ts";
import { listMigrationsInput, listMigrationsResponse } from "./list-migrations-input.ts";
import { listMigrations } from "./list-migrations.ts";
export function listMigrationsRoute(pool: Pool, auth: Auth) {
  return new Elysia({ name: "list-migrations" }).get("/api/v1/workspaces/:workspaceId/migrations",
    async ({ request, params, query, status }) => {
      try {
        const failure = await eitherSession(pool, auth, request, params.workspaceId);
        if (failure) return status(failure.status, { error: failure.reason });
        return await listMigrations(pool, params.workspaceId, query);
      } catch { return status(503, { error: "migrations_unavailable" }); }
    }, {
      params: runParams, query: listMigrationsInput,
      transform({ set }) { set.headers["cache-control"] = "no-store"; },
      error({ code, status }) { if (code === "VALIDATION") return status(400, { error: "invalid_query" }); },
      response: { 200: listMigrationsResponse, 400: migrationErrorResponse, 401: migrationErrorResponse,
        403: migrationErrorResponse, 503: migrationErrorResponse },
      detail: { "x-backplane-auth": "either", "x-backplane-run": "none", operationId: "listMigrations", tags: ["schema"] },
    });
}
