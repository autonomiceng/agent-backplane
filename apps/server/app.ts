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
import { readAuditRoute } from "./events/read-audit-route.ts";
import { createQueueRoute } from "./queue/create-queue-route.ts";
import { sendMessageRoute } from "./queue/send-message-route.ts";
import { getMessageRoute } from "./queue/get-message-route.ts";
import { claimRoute } from "./queue/claim-route.ts";
import { renewRoute } from "./queue/renew-route.ts";
import { ackRoute } from "./queue/ack-route.ts";
import { nackRoute } from "./queue/nack-route.ts";
import { listDeliveriesRoute } from "./queue/list-deliveries-route.ts";
import { replayRoute } from "./queue/replay-route.ts";
import { cancelRoute } from "./queue/cancel-route.ts";
import { recoverRoute } from "./queue/recover-route.ts";
import { beginEffectRoute } from "./queue/begin-effect-route.ts";
import { holdRoute } from "./queue/hold-route.ts";
import { reconciliationRoutes } from "./queue/reconciliation-routes.ts";
import { releaseRoute } from "./queue/release-route.ts";


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
    .use(createRunRoute(pool))
    .use(readAuditRoute(pool, auth));
  const queue = new Elysia()
    .use(createQueueRoute(pool))
    .use(sendMessageRoute(pool))
    .use(getMessageRoute(pool))
    .use(claimRoute(pool))
    .use(renewRoute(pool))
    .use(ackRoute(pool))
    .use(nackRoute(pool))
    .use(listDeliveriesRoute(pool, auth))
    .use(replayRoute(pool, auth, authUrl))
    .use(cancelRoute(pool, auth, authUrl))
    .use(recoverRoute(pool))
    .use(beginEffectRoute(pool))
    .use(holdRoute(pool))
    .use(releaseRoute(pool, auth, authUrl));

  const governance = new Elysia()
    .use(reconciliationRoutes(pool, auth, authUrl));
  return new Elysia().onRequest(({ request }) => {
    stripForwardedHeaders(request.headers);
  }).use(platform).use(queue).use(governance);
}

export type App = ReturnType<typeof createApp>;
