// onRequest is global in Elysia: explicitly restrict the early guard to compute paths.
import { Elysia, status } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "../auth/auth.ts";
import type { ComputeLauncher } from "./compute-launcher.ts";
import { deployFunctionRoute } from "./deploy-function-route.ts";
import { activateFunctionRoute } from "./activate-function-route.ts";
import { getFunctionDeploymentRoute } from "./get-function-deployment-route.ts";
export function computeRoutes(pool: Pool, auth: Auth, authUrl: string, launcher?: ComputeLauncher) {
  return new Elysia({ name: "compute" }).onRequest(({ request, set }) => {
    if (!/^\/api\/v1\/workspaces\/[^/]+\/functions(?:\/|$)/.test(new URL(request.url).pathname)) return;
    set.headers["Cache-Control"] = "no-store";
    if (!launcher) return status(503, { error: "compute_disabled" });
  }).use(deployFunctionRoute(pool, launcher))
    .use(activateFunctionRoute(pool, auth, authUrl, launcher)).use(getFunctionDeploymentRoute(pool, auth));
}
