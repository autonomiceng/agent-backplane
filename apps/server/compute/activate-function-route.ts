// Workspace Users and owning Principals activate through the same bound adapter.
import { Elysia } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "../auth/auth.ts";
import { decisionSession } from "../auth/decision-session.ts";
import type { ComputeLauncher } from "./compute-launcher.ts";
import { activateFunctionInput } from "./activate-function-input.ts";
import { computeValidation, parseComputeBody, computeFailures, deploymentResponse, deploymentParams } from "./compute-input.ts";
import { activateFunction } from "./activate-function.ts";
import { computeError } from "./compute-error.ts";
export function activateFunctionRoute(pool: Pool, auth: Auth, authUrl: string, launcher?: ComputeLauncher) {
  return new Elysia().use(decisionSession(pool, auth, authUrl)).post("/api/v1/workspaces/:workspaceId/functions/:name/deployments/:id/activate",
    async ({ actor, params, body, status }) => {
      if (!launcher) return status(503, { error: "compute_disabled" });
      try {
        const result = await activateFunction(pool, actor, params.name, params.id.toLowerCase(), body.expectedActiveId, launcher);
        if (!result.ok) { const failure = await computeError(pool, result.reason, actor, "function.activate", [params.name, params.id]); return status(failure.code, { error: failure.error }); }
        return result.value;
      }
      catch (error) { const failure = await computeError(pool, error, actor, "function.activate", [params.name, params.id]); return status(failure.code, { error: failure.error }); }
    }, { approver: true, parse: parseComputeBody, error: computeValidation, body: activateFunctionInput, params: deploymentParams, response: { 200: deploymentResponse, ...computeFailures },
      detail: { operationId: "activateFunction", tags: ["functions"], "x-backplane-auth": "either", "x-backplane-run": "principal-required" } });
}
