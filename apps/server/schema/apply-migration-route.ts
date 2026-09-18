// Run-authenticated HTTP adapter for applying a previewed Migration.
import { Elysia } from "elysia";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { runParams } from "../runs/create-run-input.ts";
import { runSession } from "../runs/run-session.ts";
import { applyMigrationErrorResponse, applyMigrationInput, applyMigrationResponse } from "./apply-migration-input.ts";
import type { MigrationProjection } from "./migration-projection.ts";
import { applyMigration } from "./apply-migration.ts";

export function applyMigrationRoute(pool: Pool, projection?: MigrationProjection) {
  return new Elysia({ name: "apply-migration" }).use(runSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/migrations",
    async ({ run, body }) => {
      const result = await applyMigration(pool, run, body);
      if (!result.ok) return Response.json({ error: result.error,
        ...(result.target ? { target: result.target } : {}),
        ...(result.sqlstate ? { sqlstate: result.sqlstate } : {}),
        ...(result.statementIndex !== undefined ? { statementIndex: result.statementIndex } : {}) },
      { status: result.status, headers: { "cache-control": "no-store" } });
      await projection?.project(run).catch(() => undefined);
      return Response.json(result.response, { status: 201, headers: { "cache-control": "no-store" } });
    },
    { run: true, transform({ set }) { set.headers["cache-control"] = "no-store"; },
      body: applyMigrationInput, params: runParams,
      response: { 201: applyMigrationResponse, 400: applyMigrationErrorResponse, 401: applyMigrationErrorResponse,
        403: applyMigrationErrorResponse, 404: applyMigrationErrorResponse, 408: applyMigrationErrorResponse, 409: applyMigrationErrorResponse,
        422: applyMigrationErrorResponse, 503: applyMigrationErrorResponse },
      error: validationError, detail: { "x-backplane-auth": "principal", "x-backplane-run": "required", operationId: "applyMigration", tags: ["schema"] } },
  );
}
