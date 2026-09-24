// Composes every primitive into one Elysia app. Opens nothing; main.ts and tests supply resources.
// The exported type is what Eden and the OpenAPI export consume.
import type { CapabilitySampler } from "./platform/capability-types.ts";
import type { Enrollment } from "./auth/enrollment.ts";
import { enrollmentRoute } from "./auth/enrollment-route.ts";
import { stripForwardedHeaders } from "./platform/forwarded-headers.ts";
import { invokeFunctionRoute } from "./compute/invoke-function-route.ts";
import { computeRoutes } from "./compute/compute-routes.ts";
import type { ComputeLauncher } from "./compute/compute-launcher.ts";
import { blobRoutes } from "./blobs/blob-routes.ts";
import type { BlobStore } from "./blobs/blob-store.ts";
import { operationsRoute } from "./platform/operations-route.ts";
import { readOperationsConfig, type OperationsConfig } from "./platform/operations.ts";
import { operationsProbe } from "./platform/operations-probe.ts";
import { readStatusConfig, statusRoute, type StatusConfig } from "./platform/status-route.ts";
import { PrincipalAdmission, principalAdmission } from "./platform/principal-admission.ts";
import { setQuotasRoute } from "./platform/set-quotas-route.ts";
import { dashboardRoutes } from "./dashboard/dashboard-routes.ts";
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
import { retentionRoutes } from "./retention/retention-routes.ts";
import { streamAuditRoute } from "./events/stream-audit-route.ts";
import { createQueueRoute } from "./queue/create-queue-route.ts";
import { sendMessageRoute } from "./queue/send-message-route.ts";
import { getMessageRoute } from "./queue/get-message-route.ts";
import { applyMigrationRoute } from "./schema/apply-migration-route.ts";
import { previewMigrationRoute } from "./schema/preview-migration-route.ts";
import { listMigrationsRoute } from "./schema/list-migrations-route.ts";
import { rebuildMigrationProjectionRoute } from "./schema/rebuild-migration-projection-route.ts";
import type { MigrationProjection } from "./schema/migration-projection.ts";
import { executeSqlRoute } from "./sql/execute-sql-route.ts";
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
import { approvalRoutes } from "./approvals/approval-routes.ts";
import { reconciliationRoutes } from "./queue/reconciliation-routes.ts";
import { restoreRoutes } from "./restore/restore-routes.ts";
import { releaseRoute } from "./queue/release-route.ts";

import { executeTransactionRoute } from "./tx/execute-transaction-route.ts";

export type AppDeps = {
  production?: boolean;
  enrollment: Enrollment;
  pool: Pool; expectedSchemaVersion: number; auth: Auth; authUrl: string;
  migrationProjection?: MigrationProjection;
  compute?: ComputeLauncher | undefined;
  blobStore?: BlobStore;
  operations?: OperationsConfig;
  status?: StatusConfig;
  capabilitySampler?: CapabilitySampler;
  insecureOrigin?: boolean;
};

export function createApp(deps: AppDeps) {
  const { auth, pool, authUrl } = deps;
  const admission = new PrincipalAdmission(), streams = new Map<string,number>();
  // Grouped sub-apps keep each Elysia type chain shallow enough for TypeScript; order within and across groups is unchanged.
  const platform = new Elysia()
    .use(principalAdmission(admission))
    .use(operationsRoute(pool, deps.operations, admission, streams, deps.enrollment, deps.capabilitySampler))
    // The public document takes only the Checkpoint time from the bounded, cached operations sample.
    .use(statusRoute(deps.status ?? readStatusConfig({}, authUrl), operationsProbe(pool, deps.operations ?? readOperationsConfig({})), pool, deps.capabilitySampler))
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
    .use(restoreRoutes(pool, auth, authUrl))
    .use(createRunRoute(pool))
    .use(readAuditRoute(pool, auth))
    .use(retentionRoutes(pool, auth, authUrl, deps.blobStore))
    .use(blobRoutes(pool, auth, authUrl, deps.blobStore))
    .use(streamAuditRoute(pool, auth, streams));
  const queue = new Elysia()
    .use(createQueueRoute(pool))
    .use(sendMessageRoute(pool))
    .use(getMessageRoute(pool))
    .use(executeSqlRoute(pool))
    .use(executeTransactionRoute(pool))
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
  const schema = new Elysia()
    .use(previewMigrationRoute(pool))
    .use(applyMigrationRoute(pool, deps.migrationProjection))
    .use(listMigrationsRoute(pool, auth))
    .use(rebuildMigrationProjectionRoute(pool, auth, authUrl, deps.migrationProjection));
  const governance = new Elysia()
    .use(computeRoutes(pool, auth, authUrl, deps.compute))
    .use(invokeFunctionRoute(pool, deps.compute))
    .use(approvalRoutes(pool, auth, authUrl))
    .use(reconciliationRoutes(pool, auth, authUrl))
    .use(dashboardRoutes(new URL("../web/dist/", import.meta.url), deps.production));
  return new Elysia().onRequest(({ request }) => {
    stripForwardedHeaders(request.headers);
  }).use(platform).use(queue).use(schema).use(governance);
}

export type App = ReturnType<typeof createApp>;
