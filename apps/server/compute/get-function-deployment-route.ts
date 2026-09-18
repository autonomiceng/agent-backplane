// Either actor can read deployment metadata within its authorized Workspace.
import { Elysia } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "../auth/auth.ts";
import { eitherSession } from "../auth/either-session.ts";
import { queryDeployment } from "./deployment-query.ts";
import { computeError } from "./compute-error.ts";
import { computeValidation, computeFailures, deploymentParams, deploymentResponse } from "./compute-input.ts";
export function getFunctionDeploymentRoute(pool: Pool, auth: Auth) {
  return new Elysia().get("/api/v1/workspaces/:workspaceId/functions/:name/deployments/:id", async ({ request, params, status }) => {
    try {
      const denied = await eitherSession(pool, auth, request, params.workspaceId);
      if (denied) return status(denied.status, { error: denied.reason });
      const deployment = await queryDeployment(pool, params.workspaceId.toLowerCase(), params.id.toLowerCase());
      if (!deployment || deployment.metadata.functionName !== params.name) return status(404, { error: "deployment_not_found" });
      return deployment.metadata;
    } catch (error) { const failure = await computeError(pool, error); return status(failure.code, { error: failure.error }); }
  }, { error: computeValidation, params: deploymentParams, response: { 200: deploymentResponse, ...computeFailures },
    detail: { operationId: "getFunctionDeployment", tags: ["functions"], "x-backplane-auth": "either", "x-backplane-run": "none" } });
}
