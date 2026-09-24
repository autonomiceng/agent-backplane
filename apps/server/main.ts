// Process entry. The only file that reads the environment and opens resources.
// Refuses to listen on an incompatible cluster (ADR-0014); readiness keeps answering after start for outages.
import { capabilityProbe } from "./platform/capability-probe.ts";
import { join } from "node:path";
import { diskSampler } from "./platform/disk-sampler.ts";
import { scheduledPurge, readPurgeInterval } from "./retention/scheduled-purge.ts";
import { scheduleInvocationReconciliation } from "./compute/reconcile-invocations.ts";
import { createComputeLauncher } from "./compute/compute-launcher.ts";
import { verifyStorageBinding } from "./blobs/storage-binding.ts";
import { createBlobStore } from "./blobs/blob-storage.ts";
import { readOperationsConfig } from "./platform/operations.ts";
import { readStatusConfig } from "./platform/status-route.ts";
import { loadMigrations } from "../../db/migrations.ts";
import { createEnrollment } from "./auth/enrollment.ts";
import { createAuth } from "./auth/auth.ts";
import { createApp } from "./app.ts";
import { readConfig } from "./platform/config.ts";
import { createPool } from "./platform/pool.ts";
import { probeReadiness } from "./platform/readiness-probe.ts";
import { createMigrationProjection } from "./schema/migration-projection.ts";

const purgeInterval = readPurgeInterval(Bun.env.BP_RETENTION_PURGE_INTERVAL);
const config = readConfig(Bun.env);
if (Bun.env.BP_AUTH_URL) console.warn("BP_AUTH_URL is deprecated; use BP_PUBLIC_URL");
const compute = createComputeLauncher({ url: Bun.env.BP_COMPUTE_URL, token: Bun.env.BP_COMPUTE_TOKEN, runtimeDigest: Bun.env.BP_WORKERD_RUNTIME_ID, timeoutMs: Bun.env.BP_COMPUTE_TIMEOUT_MS });
const blobStore = createBlobStore(Bun.env, config.dataDir);
const migrations = await loadMigrations(new URL("../../db/migrations", import.meta.url).pathname);
const expectedSchemaVersion = migrations.at(-1)?.version ?? 0;
const pool = createPool(config.databaseUrl);

const readiness = await probeReadiness(pool, expectedSchemaVersion);
if (readiness.problems.length > 0) {
  console.error(`refusing to start: ${readiness.problems.join("; ")}`);
  await pool.close({ timeout: 1 });
  process.exit(1);
}

// Storage verification writes nothing. One-shot operator initialization precedes server startup.
let stopStorage: () => Promise<void>;
try {
  stopStorage = await verifyStorageBinding(pool, blobStore, () => {
    console.error("blob_binding_lease_lost: stopping server; fence this process before replacement");
    process.exit(1);
  });
} catch (error) {
  console.error(`refusing to start: ${error instanceof Error ? error.message : "blob_binding_unavailable"}; see docs/operations/storage-identity.md`);
  await pool.close({ timeout: 1 });
  process.exit(1);
}

const enrollment = createEnrollment(pool, config);
await enrollment.prepare();
const auth = createAuth(pool, config);
const migrationProjection = createMigrationProjection(pool, config.dataDir, console, Bun.which("git", { PATH: Bun.env.PATH ?? "" }));
const stopInvocationReconciliation = scheduleInvocationReconciliation(pool);
const app = createApp({ production: Bun.env.NODE_ENV === "production", enrollment, pool, expectedSchemaVersion, auth, authUrl: config.publicOrigin, insecureOrigin: config.insecureOrigin, migrationProjection, compute, blobStore, capabilitySampler: capabilityProbe(pool, blobStore, compute), operations: readOperationsConfig(Bun.env), status: readStatusConfig(Bun.env, config.publicOrigin) }).listen({ port: config.port, idleTimeout: 30 });
const stopDisk = diskSampler(pool, Bun.env.BP_BLOB_BACKEND === "s3" ? undefined : join(config.dataDir, "blobs"));
const stopPurge = scheduledPurge(pool, purgeInterval, blobStore);
console.log(`agent-backplane listening on :${config.port}`);

const shutdown = async () => {
  await stopPurge();
  await stopDisk();
  await app.stop();
  await stopInvocationReconciliation();
  await stopStorage();
  await pool.close({ timeout: 5 });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
