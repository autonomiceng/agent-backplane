// Run-authenticated HTTP boundary for bounded, replayable atomic handoffs.
import { quotaHttp, quotaResponse } from "../platform/quotas.ts";
import { Buffer } from "node:buffer";
import { ElysiaCustomStatusResponse, Elysia, getSchemaValidator } from "elysia";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { runParams } from "../runs/create-run-input.ts";
import { runSession } from "../runs/run-session.ts";
import { executeTransactionInput, executeTransactionResponse, transactionErrorResponse } from "./execute-transaction-input.ts";
import { executeTransaction } from "./execute-transaction.ts";

export function executeTransactionRoute(pool: Pool, execute = executeTransaction) {
  const validator = getSchemaValidator(executeTransactionInput, { normalize: false });
  return new Elysia({ name: "execute-transaction" }).use(runSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/transactions",
    async ({ run, body }) => {
      const result = await execute(pool, run, body);
      if (!result.ok && result.quota) return quotaHttp(result.quota);
      if (!result.ok) return Response.json({ error: result.error, ...(result.target ? { target: result.target } : {}),
        ...(result.operationIndex === undefined ? {} : { operationIndex: result.operationIndex }),
        ...(result.sqlstate ? { sqlstate: result.sqlstate } : {}) },
      { status: result.status, headers: { "cache-control": "no-store" } });
      return Response.json(result.response, { headers: { "cache-control": "no-store" } });
    },
    {
      run: true,
      async parse({ request, status, set }, contentType) {
        set.headers["cache-control"] = "no-store";
        if (contentType !== "application/json") throw status(422, { error: "invalid_input" });
        const reader = request.body?.getReader();
        if (!reader) throw status(400, { error: "invalid_input" });
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 2097152) {
              await reader.cancel();
              throw status(422, { error: "transaction_bounds_exceeded" });
            }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw status(400, { error: "invalid_input" }); }
        // Parent apps may normalize schemas, so validate the original body before Elysia can strip fields.
        if (!validator?.Check(body)) throw status(422, { error: "invalid_input" });
        return body;
      },
      body: executeTransactionInput, params: runParams,
      response: { 429: quotaResponse, 200: executeTransactionResponse, 400: transactionErrorResponse, 401: transactionErrorResponse,
        403: transactionErrorResponse, 404: transactionErrorResponse, 408: transactionErrorResponse,
        409: transactionErrorResponse, 422: transactionErrorResponse, 503: transactionErrorResponse },
      // Elysia wraps anything thrown in parse as a 400 ParseError; the intended status travels as its cause.
      error(context) {
        if (context.code === "PARSE" && context.error.cause instanceof ElysiaCustomStatusResponse) return context.error.cause;
        return validationError(context);
      },
      detail: { "x-backplane-auth": "principal", "x-backplane-run": "required", operationId: "executeTransaction", tags: ["tx"] },
    },
  );
}
