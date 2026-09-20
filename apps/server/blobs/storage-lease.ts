// Shared operator/startup exclusion. A runtime owner must exit on a failed ownership probe.
import type { ReservedSQL, TransactionSQL } from "bun";
import type { Pool } from "../platform/pool.ts";
export async function storageLease(pool: Pool) {
  const session = await pool.reserve();
  let released = false, timer: ReturnType<typeof setInterval> | undefined;
  try {
    const [row] = await session<{ locked: boolean; pid: number }[]>`SELECT pg_try_advisory_lock(112933,32) AS locked,pg_backend_pid() AS pid`;
    if (!row?.locked) throw new Error("blob_binding_busy");
    const assertOwned = async (query: ReservedSQL | TransactionSQL = session) => {
      const [owner] = await query<{ owned: boolean }[]>`SELECT pg_backend_pid()=${row.pid} AND EXISTS(
        SELECT FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
        AND classid=112933 AND objid=32 AND objsubid=2 AND granted) AS owned`;
      if (released || !owner?.owned) throw new Error("blob_binding_lease_lost");
    };
    return { session, assertOwned,
      watch(onLost: () => void) {
        let checking = false;
        timer = setInterval(() => {
          if (checking || released) return;
          checking = true;
          const deadline = setTimeout(() => { if (!released) onLost(); }, 5000);
          void assertOwned().catch(() => { if (!released) onLost(); }).finally(() => { clearTimeout(deadline); checking = false; });
        }, 1000);
        timer.unref();
      },
      async release() {
        if (released) return;
        released = true; clearInterval(timer);
        try { await session`SELECT pg_advisory_unlock(112933,32)`; }
        catch { await session.close(); }
        finally { session.release(); }
      },
    };
  } catch (error) {
    try { if (!(error instanceof Error && error.message === "blob_binding_busy")) await session.close(); }
    finally { session.release(); }
    throw error;
  }
}
