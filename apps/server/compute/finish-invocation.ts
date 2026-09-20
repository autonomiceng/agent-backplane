// Terminal attempts commit credential deletion even when audit contention requires another attempt.
import type { ReservedSQL } from "bun";
import type { Pool } from "../platform/pool.ts";
export const finalizationBudgetMs = 5000;
export async function finishInvocation(pool: Pool, runId: string, kind: "function.complete" | "function.fail" | "function.timeout", durationMs: number, status: number | null): Promise<void> {
  const controller = new AbortController();
  let lease: ReservedSQL | undefined, closing: Promise<void> | undefined;
  const close = () => { if (lease) closing ??= lease.close().catch(() => {}); };
  controller.signal.addEventListener("abort", close, { once: true });
  const timer = setTimeout(() => controller.abort(Error("invocation_finalize_failed")), finalizationBudgetMs);
  try {
    lease = await pool.reserve({ signal: controller.signal });
    if (controller.signal.aborted) { close(); controller.signal.throwIfAborted(); }
    await finishInvocationOnConnection(lease, runId, kind, durationMs, status);
  } catch {
    throw Error("invocation_finalize_failed");
  } finally {
    clearTimeout(timer); controller.signal.removeEventListener("abort", close);
    await closing; lease?.release();
  }
}

// The reconciliation pass owns this connection and its overall deadline.
export async function finishInvocationOnConnection(pool: ReservedSQL, runId: string, kind: "function.complete" | "function.fail" | "function.timeout", durationMs: number, status: number | null): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const complete = await pool.begin(async (tx) => {
        await tx`SET LOCAL statement_timeout = 2000`;
        await tx`SET LOCAL lock_timeout = 250`;
        await tx`SELECT control.finish_invocation(${runId},${kind},${durationMs},${status})`;
        const [result] = await tx<{ complete: boolean }[]>`SELECT NOT EXISTS (
          SELECT FROM control.invocation_tokens WHERE run_id=${runId}) AND EXISTS (
          SELECT FROM audit.events e JOIN control.runs r ON r.workspace_id=e.workspace_id AND r.id=e.run_id
          WHERE r.id=${runId} AND e.kind IN ('function.complete','function.fail','function.timeout')) AS complete`;
        return result?.complete === true;
      });
      if (complete) return;
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "errno" in error
        && ["55P03", "40001", "40P01"].includes(String(error.errno)))) break;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("invocation_finalize_failed");
}
