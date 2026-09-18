// Principal invocation maps stable failures and retains admission through response buffering and finalization.
import { Elysia, t } from "elysia";
import type { Pool } from "../platform/pool.ts";
import { runSession } from "../runs/run-session.ts";
import { recordRejection } from "../runs/record-rejection.ts";
import type { ComputeLauncher } from "./compute-launcher.ts";
import { functionParams, computeValidation } from "./compute-input.ts";
import { invokeFunctionInput, invocationResponse, invocationCodes, parseInvocationBody, readInvocationBytes, InvocationError } from "./invoke-function-input.ts";
import { invokeFunction } from "./invoke-function.ts";
const failure = t.Object({ error: t.String() });
export function invokeFunctionRoute(pool: Pool, launcher?: ComputeLauncher) {
  return new Elysia().use(runSession(pool)).onRequest(async ({ request, status }) => {
    if (request.method !== "POST" || !/^\/api\/v1\/workspaces\/[^/]+\/functions\/[^/]+\/invoke\/?$/.test(new URL(request.url).pathname)) return;
    // onRequest precedes Elysia's parser, which wraps thrown size errors as parse failures.
    try { await readInvocationBytes(request.clone().body, "invocation_body_too_large"); }
    catch (error) {
      if (error instanceof InvocationError) return status(413, { error: error.reason });
      return status(422, { error: "invalid_input" });
    }
  }).post("/api/v1/workspaces/:workspaceId/functions/:name/invoke",
    async ({ request, run, params, body, status, admission }) => {
      try {
        if (!launcher) return status(503, { error: "compute_disabled" });
        return await invokeFunction(pool, run, params.name, body, launcher, request.signal);
      } catch (error) {
        const reason = error instanceof Error && Object.hasOwn(invocationCodes, error.message) ? error.message : "compute_unavailable";
        const entry = Object.entries(invocationCodes).find(([code]) => code === reason);
        await recordRejection(pool, { context: run, kind: "function.invoke", objects: [params.name], reason, sqlstate: null });
        return status(entry?.[1] ?? 503, { error: reason });
      } finally { admission.release(request); }
    }, { run: true, parse: parseInvocationBody, error: computeValidation, body: invokeFunctionInput, params: functionParams,
      response: { 200: invocationResponse, 400: failure, 401: failure, 403: failure, 404: failure, 413: failure, 422: failure, 502: failure, 503: failure, 504: failure },
      detail: { operationId: "invokeFunction", tags: ["functions"], "x-backplane-auth": "principal", "x-backplane-run": "required" } });
}
