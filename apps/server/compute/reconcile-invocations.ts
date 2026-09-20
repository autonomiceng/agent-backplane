import type { ReservedSQL } from "bun";
import type { Pool } from "../platform/pool.ts";
import { finishInvocation } from "./finish-invocation.ts";

type ReconciliationState = { stopped: boolean; running?: Promise<number> | undefined; controller?: AbortController | undefined };
const states = new WeakMap<Pool, ReconciliationState>();
// Invocation tokens cannot be renewed or recreated. Absence/expiry stays true after selection.
export function reconcileInvocations(pool: Pool): Promise<number> {
  const state = states.get(pool) ?? { stopped: false };
  states.set(pool, state);
  if (state.stopped) return Promise.resolve(0);
  if (state.running) return state.running;
  const controller = new AbortController();
  state.controller = controller;
  const pass = (async () => {
    let lease: ReservedSQL | undefined, closing: Promise<void> | undefined;
    let owned = false;
    const close = () => { if (lease) closing ??= lease.close().catch(() => {}); };
    controller.signal.addEventListener("abort", close, { once: true });
    // Includes queued reservation, selection, all finalizers and lease cleanup.
    const timer = setTimeout(() => controller.abort(Error("invocation_reconcile_deadline")), 5000);
    try {
      lease = await pool.reserve({ signal: controller.signal });
      if (controller.signal.aborted) { close(); controller.signal.throwIfAborted(); }
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
        if (controller.signal.aborted) break;
        try { await finishInvocation(lease, run.id, "function.fail", run.durationMs, null); completed++; }
        catch { /* The next bounded pass retries audit contention; SQL expiry still denies authority. */ }
      }
      return completed;
    } finally {
      try { if (owned && !controller.signal.aborted) await lease!`SELECT pg_advisory_unlock(112933,26)`; }
      catch { close(); }
      finally {
        clearTimeout(timer); controller.signal.removeEventListener("abort", close);
        await closing; lease?.release();
      }
    }
  })().finally(() => { state.running = undefined; state.controller = undefined; });
  state.running = pass;
  return pass;
}

export function scheduleInvocationReconciliation(pool: Pool) {
  const state = states.get(pool) ?? { stopped: false };
  states.set(pool, state);
  const tick = () => { void reconcileInvocations(pool).catch(() => { if (!state.stopped) console.error("invocation_reconcile_failed"); }); };
  tick();
  const timer = setInterval(tick, 5000);
  timer.unref();
  return async () => {
    state.stopped = true; clearInterval(timer);
    state.controller?.abort(Error("invocation_reconcile_stopped"));
    await state.running?.catch(() => {});
  };
}
