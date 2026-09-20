import { expect, test } from "bun:test";
import { createPool, poolSnapshot } from "../platform/pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { finishInvocation } from "./finish-invocation.ts";

test("terminal cleanup cancels a saturated reservation without leaking or releasing another borrower", async () => {
  const pool = createPool(await migratedDatabase(), 1);
  const held = await pool.reserve();
  try {
    const started = performance.now();
    await expect(finishInvocation(pool, crypto.randomUUID(), "function.fail", 1, null)).rejects.toThrow("invocation_finalize_failed");
    expect(performance.now() - started).toBeLessThan(6500);
    expect(poolSnapshot(pool)).toEqual({ inUse: 1, waiting: 0 });
    expect(await held<{ n: number }[]>`SELECT 1 AS n`).toEqual([{ n: 1 }]);
  } finally { held.release(); await pool.close(); }
}, 10000);
