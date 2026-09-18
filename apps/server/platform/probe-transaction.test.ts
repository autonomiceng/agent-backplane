import { expect, test } from "bun:test";
import { createPool, poolLimit, poolSnapshot } from "./pool.ts";
import { migratedDatabase, latestMigrationVersion } from "../testing/postgres.ts";
import { operationsProbe } from "./operations-probe.ts";
import { readOperationsConfig } from "./operations.ts";
import { probeReadiness } from "./readiness-probe.ts";
import { probeTransaction } from "./probe-transaction.ts";

test("saturated probes remove queued reservations at their deadlines and operations samples again", async () => {
  const pool = createPool(await migratedDatabase());
  const held: Awaited<ReturnType<typeof pool.reserve>>[] = [];
  try {
    const version = await latestMigrationVersion();
    for (let i = 0; i < poolLimit; i++) held.push(await pool.reserve());
    const operations = operationsProbe(pool, readOperationsConfig({}));
    const started = performance.now();
    const [ready, first] = await Promise.all([probeReadiness(pool, version), operations()]);
    expect(performance.now() - started).toBeLessThan(4000);
    expect(ready.status).toBe("not_ready");
    expect(first.database).toBeNull();
    expect(poolSnapshot(pool)).toEqual({ inUse: poolLimit, waiting: 0 });
    await Bun.sleep(Math.max(0, 5100 - (performance.now() - first.started)));
    const second = await operations();
    expect(second.started).toBeGreaterThan(first.started);
    expect(poolSnapshot(pool)).toEqual({ inUse: poolLimit, waiting: 0 });
    for (const connection of held.splice(0)) connection.release();
    await Bun.sleep(Math.max(0, 5100 - (performance.now() - second.started)));
    expect((await operations()).database).not.toBeNull();
    expect((await probeReadiness(pool, version)).status).toBe("ready");
  } finally { for (const connection of held) connection.release(); await pool.close(); }
}, 20000);

test("a probe deadline terminates an active transaction before sequential statements retain its connection", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const started = performance.now();
    await expect(probeTransaction(pool, 300, async tx => {
      await tx`SELECT pg_sleep(0.2)`;
      await tx`SELECT pg_sleep(0.2)`;
    })).rejects.toBeDefined();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(poolSnapshot(pool)).toEqual({ inUse: 0, waiting: 0 });
    const [settings] = await pool`SELECT current_setting('transaction_read_only') AS readonly, current_setting('transaction_timeout') AS timeout`;
    expect(settings).toEqual({ readonly: "off", timeout: "0" });
  } finally { await pool.close(); }
});
