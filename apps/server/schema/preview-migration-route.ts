// Run-authenticated HTTP adapter for live Migration previews.
import { Elysia } from "elysia";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { runParams } from "../runs/create-run-input.ts";
import { runSession } from "../runs/run-session.ts";
import { migrationErrorResponse, previewMigrationInput, previewMigrationResponse } from "./preview-migration-input.ts";
import { previewMigration } from "./preview-migration.ts";

export function previewMigrationRoute(pool: Pool) {
  return new Elysia({ name: "preview-migration" }).use(runSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/migrations/preview",
    async ({ run, body }) => {
      const result = await previewMigration(pool, run, body);
      if (!result.ok) return Response.json({ error: result.error,
        ...(result.sqlstate ? { sqlstate: result.sqlstate } : {}),
        ...(result.statementIndex !== undefined ? { statementIndex: result.statementIndex } : {}) },
      { status: result.status, headers: { "cache-control": "no-store" } });
      return Response.json(result.response, { headers: { "cache-control": "no-store" } });
    },
    { run: true, transform({ set }) { set.headers["cache-control"] = "no-store"; },
      body: previewMigrationInput, params: runParams,
      response: { 200: previewMigrationResponse, 400: migrationErrorResponse, 401: migrationErrorResponse,
        403: migrationErrorResponse, 408: migrationErrorResponse, 409: migrationErrorResponse,
        422: migrationErrorResponse, 503: migrationErrorResponse },
      error: validationError, detail: { "x-backplane-auth": "principal", "x-backplane-run": "required", operationId: "previewMigration", tags: ["schema"] } },
  );
}
