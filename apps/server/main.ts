// Process entry. The only file that reads the environment and opens resources.
// Refuses to listen on an incompatible cluster (ADR-0014); readiness keeps answering after start for outages.
import { diskSampler } from "./platform/disk-sampler.ts";
import { readOperationsConfig } from "./platform/operations.ts";
import { loadMigrations } from "../../db/migrations.ts";
import { createEnrollment } from "./auth/enrollment.ts";
import { createAuth } from "./auth/auth.ts";
import { createApp } from "./app.ts";
import { readConfig } from "./platform/config.ts";
import { createPool } from "./platform/pool.ts";
import { probeReadiness } from "./platform/readiness-probe.ts";

const config = readConfig(Bun.env);
if (Bun.env.BP_AUTH_URL) console.warn("BP_AUTH_URL is deprecated; use BP_PUBLIC_URL");
const migrations = await loadMigrations(new URL("../../db/migrations", import.meta.url).pathname);
const expectedSchemaVersion = migrations.at(-1)?.version ?? 0;
const pool = createPool(config.databaseUrl);

const readiness = await probeReadiness(pool, expectedSchemaVersion);
if (readiness.problems.length > 0) {
  console.error(`refusing to start: ${readiness.problems.join("; ")}`);
  await pool.close({ timeout: 1 });
  process.exit(1);
}

const enrollment = createEnrollment(pool, config);
await enrollment.prepare();
const auth = createAuth(pool, config);
const app = createApp({ enrollment, pool, expectedSchemaVersion, auth, authUrl: config.publicOrigin, insecureOrigin: config.insecureOrigin, operations: readOperationsConfig(Bun.env) }).listen(config.port);
const stopDisk = diskSampler(pool);
console.log(`agent-backplane listening on :${config.port}`);

const shutdown = async () => {
  await stopDisk();
  await app.stop();
  await pool.close({ timeout: 5 });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
