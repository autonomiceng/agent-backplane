// Local development without docker: an embedded cluster with pgmq and migrations, alive until Ctrl-C.
// Prints the BP_DATABASE_URL to export before `bun run dev`.
import { startCluster, migratedDatabase } from "./postgres.ts";

const cluster = await startCluster();
Bun.env.BP_TEST_POSTGRES_URL = cluster.url;
const url = await migratedDatabase();
console.log(`BP_DATABASE_URL=${url}`);
const stop = async () => {
  await cluster.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
