// Owned crash/restart fixture with the same app and lifecycle hook proposed for main.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/app.ts";
import { createAuth } from "../../apps/server/auth/auth.ts";
import { createEnrollment } from "../../apps/server/auth/enrollment.ts";
import { createPool } from "../../apps/server/platform/pool.ts";
import { createComputeLauncher } from "../../apps/server/compute/compute-launcher.ts";
import { scheduleInvocationReconciliation } from "../../apps/server/compute/reconcile-invocations.ts";
import { latestMigrationVersion } from "../../apps/server/testing/postgres.ts";
const pool = createPool(Bun.env.BP_TEST_DATABASE_URL!);
const dataDir = Bun.env.BP_TEST_SERVER_DIRECTORY ?? await mkdtemp(join(tmpdir(), "bp-workerd-server-"));
const config = { publicOrigin: "http://localhost", authSecret: "tenancy-tests-use-a-secret-longer-than-32-characters", dataDir, signup: "open" } as const;
const enrollment = createEnrollment(pool, config);
await enrollment.prepare();
const compute = createComputeLauncher({ url: Bun.env.BP_COMPUTE_URL, token: Bun.env.BP_COMPUTE_TOKEN, runtimeDigest: Bun.env.BP_WORKERD_RUNTIME_ID, timeoutMs: Bun.env.BP_COMPUTE_TIMEOUT_MS });
const app = createApp({ pool, auth: createAuth(pool, config), enrollment, authUrl: config.publicOrigin,
  expectedSchemaVersion: await latestMigrationVersion(), compute });
// Use the shipped Elysia listener so context.server reaches the invocation route.
app.listen({ hostname: Bun.env.BP_TEST_API_HOST ?? "127.0.0.1", port: Number(Bun.env.BP_TEST_API_PORT ?? 0), idleTimeout: 10, reusePort: false });
const server = app.server;
if (!server) throw Error("fixture listener missing");
const stop = scheduleInvocationReconciliation(pool);
console.log(JSON.stringify({ url: server.url.href }));
const close = async () => { await server.stop(true); await stop(); await pool.close(); if (!Bun.env.BP_TEST_SERVER_DIRECTORY) await rm(dataDir, { recursive: true, force: true }); process.exit(0); };
process.on("SIGTERM", close); process.on("SIGINT", close);
