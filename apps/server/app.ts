// Composes every primitive into one Elysia app. Opens nothing; main.ts and tests supply resources.
// The exported type is what Eden and the OpenAPI export consume.
import type { Enrollment } from "./auth/enrollment.ts";
import { enrollmentRoute } from "./auth/enrollment-route.ts";
import { stripForwardedHeaders } from "./platform/forwarded-headers.ts";
import { operationsRoute } from "./platform/operations-route.ts";
import type { OperationsConfig } from "./platform/operations.ts";
import { PrincipalAdmission, principalAdmission } from "./platform/principal-admission.ts";
import { setQuotasRoute } from "./platform/set-quotas-route.ts";
import { openapiPlugin } from "./openapi-plugin.ts";
import { Elysia } from "elysia";
import type { Auth } from "./auth/auth.ts";
import { principalCredentialRoutes } from "./auth/principal-credential-routes.ts";
import { listPrincipalsRoute } from "./auth/list-principals-route.ts";
import { tenancyRoutes } from "./auth/tenancy-routes.ts";
import { healthRoute } from "./platform/health-route.ts";
import type { Pool } from "./platform/pool.ts";
import { createRunRoute } from "./runs/create-run-route.ts";


export type AppDeps = {
  enrollment: Enrollment;
  pool: Pool; expectedSchemaVersion: number; auth: Auth; authUrl: string;
  operations?: OperationsConfig;
  insecureOrigin?: boolean;
};

export function createApp(deps: AppDeps) {
  const { auth, pool, authUrl } = deps;
  const admission = new PrincipalAdmission(), streams = new Map<string,number>();
  // Grouped sub-apps keep each Elysia type chain shallow enough for TypeScript; order within and across groups is unchanged.
  const platform = new Elysia()
    .use(principalAdmission(admission))
    .use(operationsRoute(pool, deps.operations, admission, streams, deps.enrollment))
    .use(openapiPlugin())
    .use(healthRoute(pool, deps.expectedSchemaVersion, deps.enrollment, deps.insecureOrigin, deps.operations?.token))
    .use(enrollmentRoute(deps.enrollment, authUrl))
    .all("/api/auth/*", ({ request }) => auth.handler(request), {
      detail: { hide: true },
    })
    .use(tenancyRoutes(pool, auth, authUrl))
    .use(principalCredentialRoutes(pool, auth, authUrl))
    .use(listPrincipalsRoute(pool, auth, authUrl))
    .use(setQuotasRoute(pool, auth, authUrl))
    .use(createRunRoute(pool));



  return new Elysia().onRequest(({ request }) => {
    stripForwardedHeaders(request.headers);
  }).use(platform);
}

export type App = ReturnType<typeof createApp>;
