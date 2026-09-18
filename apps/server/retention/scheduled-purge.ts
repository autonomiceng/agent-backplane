// Main owns this non-overlapping worker; every batch uses a built-in Principal and a fresh Run.
import type { ReservedSQL } from "bun";
import type { Pool } from "../platform/pool.ts";
import type { BlobStore } from "../blobs/blob-store.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { purgePayloads } from "./purge-payloads.ts";
export function readPurgeInterval(value = "1h"): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  const interval = match ? Number(match[1]) * (units[match[2] ?? ""] ?? 0) : 0;
  if (!Number.isSafeInteger(interval) || interval <= 0 || interval > 2147483647) throw new Error("invalid_retention_purge_interval");
  return interval;
}
export function scheduledPurge(pool: Pool, interval: number, store?: BlobStore, log: Pick<Console, "log" | "error"> = console) {
  let stopped = false, running: Promise<void> | undefined;
  const tick = async () => {
    const started = performance.now();
    let lease: ReservedSQL | undefined, ownsLease = false;
    let batches = 0, removed = 0, failures = 0;
    try {
      lease = await pool.reserve();
      const [lock] = await lease<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(112933,29) AS locked`;
      if (!lock?.locked) { log.log(JSON.stringify({ event: "retention.purge", skipped: "lease_held" })); return; }
      ownsLease = true;
      const principals = await pool<{ workspaceId: string; principalId: string }[]>`
        SELECT workspace_id AS "workspaceId",id AS "principalId" FROM control.principals WHERE system='retention' ORDER BY workspace_id`;
      for (const principal of principals) {
        if (stopped) break;
        try {
          for (let batch = 0; batch < 100 && !stopped; batch++) {
            const context = await withRunContext(pool, principal, async (_tx, emit, runId) => {
              if (!runId) throw new Error("run_required");
              await emit("runs.created", [runId], 1, { label: "scheduled retention" });
              return { ...principal, runId };
            }, { newRun: { harness: "backplane", label: "scheduled retention" } });
            const result = await purgePayloads(pool, context, 100, store);
            if (!result.ok) throw new Error(result.error);
            batches++; removed += Object.values(result.value.counts).reduce((a, b) => a + b, 0);
            if (result.value.cleanupPending) failures++;
            if (!result.value.hasMore) break;
          }
        } catch (error) { failures++; log.error(JSON.stringify({ event: "retention.purge", workspaceId: principal.workspaceId, error: String(error) })); }
      }
      log.log(JSON.stringify({ event: "retention.purge", batches, removed, failures, elapsedMs: Math.round(performance.now() - started) }));
    } catch (error) { log.error(JSON.stringify({ event: "retention.purge", error: String(error), batches, removed })); }
    finally {
      if (lease) {
        try { if (ownsLease) await lease`SELECT pg_advisory_unlock(112933,29)`; }
        catch { await lease.close(); }
        finally { lease.release(); }
      }
    }
  };
  const timer = setInterval(() => { if (!running) running = tick().finally(() => { running = undefined; }); }, interval);
  timer.unref();
  return async () => { stopped = true; clearInterval(timer); await running; };
}
