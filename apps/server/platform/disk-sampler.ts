// Main samples filesystem bytes and database size; bounded history is written with Run attribution.
import { opendir, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "./pool.ts";
async function directoryBytes(path: string, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  let bytes = 0;
  const entries = await opendir(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!entries) return 0;
  for await (const entry of entries) {
    signal.throwIfAborted();
    const child = join(path, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(child, signal);
    else if (entry.isFile()) bytes += (await lstat(child)).size;
  }
  return bytes;
}
export async function sampleDisk(pool: Pool, blobDir?: string): Promise<void> {
  const blobBytes = blobDir ? await directoryBytes(blobDir, AbortSignal.timeout(10000)) : 0;
  await pool.begin(async tx => {
    const [lock] = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(112933,28) AS locked`;
    if (!lock?.locked) return;
    await tx`SELECT control.record_disk_sample(pg_database_size(current_database()),${blobBytes})`;
  });
}
export function diskSampler(pool: Pool, blobDir?: string) {
  let running: Promise<void> | undefined;
  const tick = () => { if (!running) running = sampleDisk(pool, blobDir).catch(() => console.error("operations.disk_sample_failed")).finally(() => { running = undefined; }); };
  tick();
  const timer = setInterval(tick, 60000); timer.unref();
  return async () => { clearInterval(timer); await running; };
}
