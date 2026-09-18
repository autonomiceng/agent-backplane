// Production telemetry must distinguish observable health from a missing backup or a saturated pool.
import { expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { createPool, poolLimit, poolSnapshot } from "./pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { recoveryFixture } from "../testing/session.ts";
import { operationsRoute } from "./operations-route.ts";
import { readOperationsConfig } from "./operations.ts";
import { PrincipalAdmission } from "./principal-admission.ts";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleDisk } from "./disk-sampler.ts";

test("a live pool reports reservations and waiters and operations never returns unknown", async () => {
  const pool = createPool(await migratedDatabase());
  const reserved: Awaited<ReturnType<typeof pool.reserve>>[] = [];
  let queued: ReturnType<typeof pool.reserve> | undefined;
  try {
    await recoveryFixture(pool);
    await sampleDisk(pool); await sampleDisk(pool);
    for (let i=0; i<poolLimit; i++) reserved.push(await pool.reserve());
    queued = pool.reserve();
    expect(poolSnapshot(pool)).toEqual({inUse:poolLimit,waiting:1});
    reserved.pop()?.release(); reserved.push(await queued); queued = undefined;
    expect(poolSnapshot(pool)).toEqual({inUse:poolLimit,waiting:0});
    for (const connection of reserved.splice(0)) connection.release();
    expect(poolSnapshot(pool)).toEqual({inUse:0,waiting:0});
    const app = new Elysia().use(operationsRoute(pool,readOperationsConfig({BP_OPERATIONS_TOKEN:"test"}),new PrincipalAdmission(),new Map()));
    const get = (path:string) => app.handle(new Request(`http://localhost${path}`, {headers:{authorization:"Bearer test"}}));
    const document = await (await get("/health/operations")).json();
    expect(document.status).toBe("degraded");
    expect(document.codes).toContain("backup_unavailable");
    expect(document.database.poolInUse.value).toBe(0);
    expect(document.database.poolWaiting.value).toBe(0);
    expect(document.disk.databaseBytes.value).toBeGreaterThan(0);
    expect(document.disk.growthBytesPerSecond.value).toBeNumber();
    expect(document.events.newestAgeSeconds.value).toBeGreaterThanOrEqual(0);
    const metrics = await (await get("/metrics")).text();
    expect(metrics).toContain("bp_pool_waiting 0\n");
    expect(metrics).toContain("bp_disk_database_bytes ");
    expect(metrics).toContain("bp_event_newest_age_seconds ");
    const [sample] = await pool`SELECT run_id FROM control.disk_samples LIMIT 1`;
    expect(sample?.run_id).toBeString();
  } finally {
    for (const connection of reserved) connection.release();
    if (queued) await queued.then(connection => connection.release(), () => undefined);
    await pool.close();
  }
});

test("global disk sampling needs no Workspace and a held lock writes no sample or Run", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    expect(await pool`SELECT FROM control.workspaces`).toHaveLength(0);
    await pool.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(112933,28)`;
      await sampleDisk(pool);
      expect(await tx`SELECT FROM control.disk_samples`).toHaveLength(0);
    });
    await sampleDisk(pool);
    const [sample] = await pool`SELECT to_jsonb(s) AS sample FROM control.disk_samples s`;
    expect(sample.sample.database_bytes).toBeGreaterThan(0);
    expect(sample.sample.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(sample.sample).not.toHaveProperty("workspace_id");
    expect(await pool`SELECT FROM control.runs`).toHaveLength(0);
    expect(await pool`SELECT FROM audit.events`).toHaveLength(0);
  } finally { await pool.close(); }
});

test("a blob removed during sampling leaves a valid sample and the next sample sees its replacement", async () => {
  const pool = createPool(await migratedDatabase());
  const dir = await fs.mkdtemp(join(tmpdir(), "bp-disk-race-")), path = join(dir, "blob");
  const lstat = fs.lstat;
  await fs.writeFile(path, "blob");
  const race = spyOn(fs, "lstat").mockImplementationOnce(async () => {
    await fs.unlink(path);
    await lstat(path);
    throw new Error("removed blob still exists");
  });
  try {
    await sampleDisk(pool, dir);
    race.mockRestore();
    const [first] = await pool`SELECT database_bytes::float8 AS database, blob_bytes::int AS blob FROM control.disk_samples ORDER BY observed_at DESC LIMIT 1`;
    expect(first.database).toBeGreaterThan(0);
    expect(first.blob).toBe(0);
    await fs.writeFile(path, "replacement");
    await sampleDisk(pool, dir);
    const [second] = await pool`SELECT blob_bytes::int AS blob FROM control.disk_samples ORDER BY observed_at DESC LIMIT 1`;
    expect(second.blob).toBe(Buffer.byteLength("replacement"));
  } finally { race.mockRestore(); await pool.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
