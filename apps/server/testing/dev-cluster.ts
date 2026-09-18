// Local development without docker: an embedded cluster with pgmq and migrations, alive until Ctrl-C.
// Writes a private env file for `bun --env-file=<path> run dev`.
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCluster, migratedDatabase } from "./postgres.ts";

const cluster = await startCluster();
Bun.env.BP_TEST_POSTGRES_URL = cluster.url;
const directory = await mkdtemp(join(tmpdir(), "bp-dev-env-"));
try {
  const url = await migratedDatabase();
  const path = join(directory, "database.env");
  await writeFile(path, `BP_DATABASE_URL=${url}\n`, { mode: 0o600, flag: "wx" });
  console.log(`bun --env-file=${path} run dev`);
} catch (error) {
  try { await cluster.stop(); } finally { await rm(directory, { recursive: true, force: true }); }
  throw error;
}
const stop = async () => {
  try { await cluster.stop(); } finally { await rm(directory, { recursive: true, force: true }); }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
