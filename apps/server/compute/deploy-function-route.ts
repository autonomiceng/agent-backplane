// Principal-only registration translates failures after the adapter has rolled back.
import { Elysia } from "elysia";
import type { Pool } from "../platform/pool.ts";
import { runSession } from "../runs/run-session.ts";
import { deployFunctionInput } from "./deploy-function-input.ts";
import { computeValidation, parseComputeBody, computeFailures, deploymentResponse, functionParams } from "./compute-input.ts";
import { deployFunction } from "./deploy-function.ts";
import { computeError } from "./compute-error.ts";
export function deployFunctionRoute(pool: Pool, runtimeDigest: string) {
  return new Elysia().use(runSession(pool)).post("/api/v1/workspaces/:workspaceId/functions/:name/deployments",
    async ({ run, params, body, status }) => {
      try {
        const result = await deployFunction(pool, run, params.name, body, runtimeDigest);
        if (!result.ok) { const failure = await computeError(pool, result.reason, run, "function.deploy", [params.name, body.id]); return status(failure.code, { error: failure.error }); }
        return status(result.value.created ? 201 : 200, result.value.metadata);
      }
      catch (error) { const failure = await computeError(pool, error, run, "function.deploy", [params.name, body.id]); return status(failure.code, { error: failure.error }); }
    }, { run: true, parse: parseComputeBody, error: computeValidation, body: deployFunctionInput, params: functionParams, response: { 200: deploymentResponse, 201: deploymentResponse, ...computeFailures },
      detail: { operationId: "deployFunction", tags: ["functions"], "x-backplane-auth": "principal", "x-backplane-run": "required" } });
}
