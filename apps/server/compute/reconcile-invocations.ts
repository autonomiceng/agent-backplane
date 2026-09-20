import type { Pool } from "../platform/pool.ts";
import { finishInvocation } from "./finish-invocation.ts";

const passes = new WeakMap<Pool, Promise<number>>();
// Invocation tokens cannot be renewed or recreated. Absence/expiry stays true after selection.
export function reconcileInvocations(pool: Pool): Promise<number> {
  const running = passes.get(pool);
  if (running) return running;
  const pass = (async () => {
    const lease = await pool.reserve();
    let owned = false;
    try {
      const [lock] = await lease<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(112933,26) AS locked`;
      if (!lock?.locked) return 0;
      owned = true;
      const runs = await lease.begin(async tx => {
        await tx`SET LOCAL statement_timeout = 2000`;
        return tx<{ id: string; durationMs: number }[]>`SELECT r.id,
          least(2147483647,greatest(0,ceil(extract(epoch FROM clock_timestamp()-r.created_at)*1000)))::int AS "durationMs"
          FROM control.runs r
          WHERE r.invocation_deployment_id IS NOT NULL AND r.parent_run_id IS NOT NULL
            AND NOT EXISTS (SELECT FROM control.invocation_tokens t WHERE t.run_id=r.id AND t.expires_at>clock_timestamp())
            AND NOT EXISTS (SELECT FROM audit.events e WHERE e.workspace_id=r.workspace_id AND e.run_id=r.id
              AND e.kind IN ('function.complete','function.fail','function.timeout'))
          ORDER BY r.created_at,r.id LIMIT 16`;
      });
      let completed = 0;
      for (const run of runs) {
        try { await finishInvocation(lease, run.id, "function.fail", run.durationMs, null); completed++; }
        catch { /* The next bounded pass retries audit contention. */ }
      }
      return completed;
    } finally {
      try { if (owned) await lease`SELECT pg_advisory_unlock(112933,26)`; }
      catch { await lease.close(); }
      finally { lease.release(); }
    }
  })().finally(() => { passes.delete(pool); });
  passes.set(pool, pass);
  return pass;
}

export function scheduleInvocationReconciliation(pool: Pool) {
  const tick = () => { void reconcileInvocations(pool).catch(() => console.error("invocation_reconcile_failed")); };
  tick();
  const timer = setInterval(tick, 5000);
  timer.unref();
  return async () => { clearInterval(timer); await passes.get(pool)?.catch(() => {}); };
}
