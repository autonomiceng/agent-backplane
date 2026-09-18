// Wires the SQL contract to Principal authentication, Run ownership and the transaction adapter.
import { quotaHttp, quotaResponse } from "../platform/quotas.ts";
import { Elysia } from "elysia";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { runParams } from "../runs/create-run-input.ts";
import { runSession } from "../runs/run-session.ts";
import { executeSqlInput, executeSqlResponse, sqlErrorResponse } from "./execute-sql-input.ts";
import { executeSql } from "./execute-sql.ts";

export function executeSqlRoute(pool: Pool) {
  return new Elysia({ name: "execute-sql" }).use(runSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/sql",
    async ({ run, body }) => {
      const result = await executeSql(pool, run, body);
      if (!result.ok && result.quota) return quotaHttp(result.quota);
      if (!result.ok) return Response.json({ error: result.error, ...(result.target ? { target: result.target } : {}), ...(result.sqlstate ? { sqlstate: result.sqlstate } : {}) },
        { status: result.status, headers: { "cache-control": "no-store" } });
      return Response.json(result.response, { headers: { "cache-control": "no-store" } });
    },
    {
      run: true,
      transform({ set }) { set.headers["cache-control"] = "no-store"; },
      body: executeSqlInput,
      params: runParams,
      response: { 429: quotaResponse, 200: executeSqlResponse, 400: sqlErrorResponse, 401: sqlErrorResponse, 403: sqlErrorResponse,
        404: sqlErrorResponse, 409: sqlErrorResponse, 408: sqlErrorResponse, 422: sqlErrorResponse, 503: sqlErrorResponse },
      error: validationError,
      detail: { "x-backplane-auth": "principal", "x-backplane-run": "required", operationId: "executeSql", tags: ["sql"] },
    },
  );
}
