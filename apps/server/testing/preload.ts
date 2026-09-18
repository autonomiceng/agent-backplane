// Starts one embedded cluster for the whole integration run and publishes its url to every test file.
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll } from "bun:test";
import { startCluster } from "./postgres.ts";

const directory = tmpdir();
const before = new Set(readdirSync(directory).filter(name => name.startsWith("bp-")));
const cluster = await startCluster();
Bun.env.BP_TEST_POSTGRES_URL = cluster.url;
// Bun runs a preload's afterAll once after every file; the runner exits without emitting a process exit event.
afterAll(async () => {
  await cluster.stop();
  const leaked = readdirSync(directory).filter(name => name.startsWith("bp-") && !before.has(name)).sort();
  if (leaked.length) throw new Error(`a fixture or test leaves scratch under the temp directory (${directory}):\n${leaked.join("\n")}`);
}, 120_000); // Stopping the embedded cluster exceeds Bun's 5 s hook default on slower CI runners.
