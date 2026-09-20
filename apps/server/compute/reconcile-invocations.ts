import type { ReservedSQL } from "bun";
import type { Pool } from "../platform/pool.ts";
import { finishInvocationOnConnection } from "./finish-invocation.ts";

type ReconciliationState = { stopped: boolean; scheduled?: boolean; cursor?: { expiresAt: string; id: string } | undefined; running?: Promise<number> | undefined; controller?: AbortController | undefined };
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
        return tx<{ id: string; expiresAt: string; durationMs: number }[]>`SELECT r.id,p.expires_at::text AS "expiresAt",
          least(2147483647,greatest(0,ceil(extract(epoch FROM clock_timestamp()-r.created_at)*1000)))::int AS "durationMs"
          FROM control.invocation_pending p JOIN control.runs r ON r.id=p.run_id
          WHERE p.expires_at<=statement_timestamp()-interval '10 seconds'
            AND (${state.cursor?.expiresAt ?? null}::timestamptz IS NULL OR
              (p.expires_at,p.run_id)>(${state.cursor?.expiresAt ?? null}::timestamptz,${state.cursor?.id ?? null}::uuid))
          ORDER BY p.expires_at,p.run_id LIMIT 16`;
      });
      let completed = 0, attempted = 0;
      for (const run of runs) {
        if (controller.signal.aborted) break;
        state.cursor = { expiresAt: run.expiresAt, id: run.id }; attempted++;
        try { await finishInvocationOnConnection(lease, run.id, "function.fail", run.durationMs, null); completed++; }
        catch { /* The next bounded pass retries audit contention; SQL expiry still denies authority. */ }
      }
      if (attempted === runs.length && runs.length < 16) state.cursor = undefined;
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
  if (state.scheduled || state.running) throw Error("invocation_reconcile_already_running");
  state.stopped = false; state.scheduled = true;
  states.set(pool, state);
  const tick = () => { void reconcileInvocations(pool).catch(() => { if (!state.stopped) console.error("invocation_reconcile_failed"); }); };
  tick();
  const timer = setInterval(tick, 5000);
  timer.unref();
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true; state.scheduled = false;
    state.stopped = true; clearInterval(timer);
    state.controller?.abort(Error("invocation_reconcile_stopped"));
    await state.running?.catch(() => {});
  };
}
