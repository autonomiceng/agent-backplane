import type { ReservedSQL, TransactionSQL } from "bun";
import type { Pool } from "./pool.ts";

// Aborting reserve removes its queued waiter; an already borrowed connection must be closed separately.
export async function probeTransaction<T>(pool: Pool, timeoutMs: number, read: (tx: TransactionSQL) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let connection: ReservedSQL | undefined;
  let closing: Promise<void> | undefined;
  const timer = setTimeout(() => {
    controller.abort(new Error("probe_deadline"));
    closing = connection?.close().catch(() => {});
  }, timeoutMs);
  try {
    connection = await pool.reserve({ signal: controller.signal });
    controller.signal.throwIfAborted();
    return await connection.begin("READ ONLY", async tx => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}; SET LOCAL lock_timeout = ${timeoutMs}; SET LOCAL transaction_timeout = ${timeoutMs}`);
      return read(tx);
    });
  } finally {
    clearTimeout(timer);
    await closing;
    connection?.release();
  }
}
