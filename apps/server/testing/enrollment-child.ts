// Crash-boundary server for enrollment.test.ts. The parent owns and kills the captured child PID.
import { createApp } from "../app.ts";
import { createAuth } from "../auth/auth.ts";
import { createEnrollment } from "../auth/enrollment.ts";
import { createPool } from "../platform/pool.ts";
import { latestMigrationVersion } from "./postgres.ts";
const [url, dataDir, boundary] = process.argv.slice(2);
if (!url || !dataDir) throw new Error("missing enrollment child arguments");
const pool = createPool(url);
const config = { dataDir, publicOrigin: "http://localhost", authSecret: "enrollment-tests-secret-longer-than-thirty-two", signup: "closed" } as const;
const enrollment = createEnrollment(pool, config, async point => {
  if (point === boundary) {
    process.send?.({ boundary: point });
    await new Promise(() => {});
  }
});
await enrollment.prepare();
const app = createApp({ pool, enrollment, expectedSchemaVersion: await latestMigrationVersion(), auth: createAuth(pool, config), authUrl: config.publicOrigin }).compile();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
process.send?.({ port: server.port });
