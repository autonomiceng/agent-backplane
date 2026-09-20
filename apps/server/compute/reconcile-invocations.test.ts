import { SQL } from "bun";
import { loadMigrations, migrate } from "../../../db/migrations.ts";
import { sqlMigrationRunner } from "../../../db/sql-migration-runner.ts";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createPool, poolSnapshot, type Pool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { principalFixture, issueKey, createRun, testApp } from "../testing/session.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { finishInvocation } from "./finish-invocation.ts";
import { reconcileInvocations, scheduleInvocationReconciliation } from "./reconcile-invocations.ts";

async function orphanFixture(pool: Pool, count: number, existing?: Awaited<ReturnType<typeof principalFixture>>) {
  const f = existing ? { ...existing } : await principalFixture(pool);
  if (existing) {
    const headers = { cookie: f.cookie, origin: "http://localhost", "content-type": "application/json" };
    const workspace = await f.app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers, body: JSON.stringify({ name: "Recovery" }),
    }));
    expect(workspace.status).toBe(201); f.workspaceId = (await workspace.json()).id;
    const principal = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${f.workspaceId}/principals`, {
      method: "POST", headers, body: JSON.stringify({ name: "Recovery" }),
    }));
    expect(principal.status).toBe(201); f.principalId = (await principal.json()).id;
  }
  const key = await issueKey(f.app, f.cookie, f.workspaceId, f.principalId), parent = await createRun(f.app, key, f.workspaceId);
  const runtimeDigest = "workerd-binary-sha256:" + "a".repeat(64);
  const artifact = { source: "host-declared" as const, reference: "fixture:local", hostObservedImageId: null };
  const app = await testApp(pool, { compute: { runtimeDigest, async verify() { return { runtimeDigest, controlHash: "b".repeat(64), artifact }; },
    async prepare() { return { ok: true, value: artifact }; } } });
  const id = crypto.randomUUID(), url = `http://localhost/api/v1/workspaces/${f.workspaceId}/functions/orphan/deployments`;
  const headers = { authorization: `Bearer ${key}`, "x-backplane-run": parent, "content-type": "application/json" };
  expect((await app.handle(new Request(url, { method: "POST", headers, body: JSON.stringify({ id, bundle: "export default {fetch(){}}", entryPoint: "default", outboundUrls: [] }) }))).status).toBe(201);
  expect((await app.handle(new Request(`${url}/${id}/activate`, { method: "POST", headers, body: '{"expectedActiveId":null}' }))).status).toBe(200);
  const caller = { workspaceId: f.workspaceId, principalId: f.principalId, runId: parent };
  // Reproduce a crash after committed authority creation and before dispatch using the server's closed definer.
  const runIds = await withRunContext(pool, caller, async tx => {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const [run] = await tx<{ id: string }[]>`SELECT run_id AS id FROM control.create_invocation(${id},${randomBytes(32)},1)`;
      ids.push(run!.id);
    }
    return ids;
  });
  await Bun.sleep(5);
  return { caller, runIds, deploymentId: id, fixture: f };
}

async function agePending(database: string) {
  const admin = new SQL(adminUrl(database));
  try { await admin`UPDATE control.invocation_pending SET expires_at=expires_at-interval '11 seconds'`; }
  finally { await admin.close(); }
}

test("reconciler shutdown cancels saturated reservations and late passes for only its own pool", async () => {
  const database = await migratedDatabase(), pool = createPool(database, 1), other = createPool(database);
  let held: Awaited<ReturnType<typeof pool.reserve>> | undefined, stop: (() => Promise<void>) | undefined;
  try {
    const f = await orphanFixture(other, 1);
    await agePending(database);
    held = await pool.reserve();
    stop = scheduleInvocationReconciliation(pool);
    expect(poolSnapshot(pool)).toEqual({ inUse: 1, waiting: 1 });
    const started = performance.now(); await stop();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(poolSnapshot(pool)).toEqual({ inUse: 1, waiting: 0 });
    expect(await reconcileInvocations(pool)).toBe(0);
    expect(poolSnapshot(pool)).toEqual({ inUse: 1, waiting: 0 });
    const stopAgain = scheduleInvocationReconciliation(pool);
    await stop(); // A stale stop closure must not stop the new scheduler.
    expect(poolSnapshot(pool)).toEqual({ inUse: 1, waiting: 1 });
    await stopAgain();
    expect(poolSnapshot(pool)).toEqual({ inUse: 1, waiting: 0 });
    expect(await reconcileInvocations(other)).toBe(1);
    expect(await other<{ kind: string }[]>`SELECT kind FROM audit.events WHERE run_id=${f.runIds[0]!} AND kind LIKE 'function.%'`).toEqual([{ kind: "function.fail" }]);
  } finally { await stop?.(); held?.release(); await pool.close(); await other.close(); }
});

test("recovery bounds a contended batch, advances to another Workspace, and later repairs immutable terminals", async () => {
  const database = await migratedDatabase(), pool = createPool(database);
  const release = Promise.withResolvers<void>(), acquired = Promise.withResolvers<void>();
  let blocker: Promise<unknown> | undefined;
  try {
    // Contended orphans may consume a pass; a later Workspace must still progress.
    const f = await orphanFixture(pool, 6);
    const healthy = await orphanFixture(pool, 1, f.fixture);
    await agePending(database);
    blocker = withRunContext(pool, f.caller, async () => { acquired.resolve(); await release.promise; });
    await acquired.promise;
    const started = performance.now();
    let otherRepaired = await reconcileInvocations(pool);
    expect(otherRepaired).toBeGreaterThanOrEqual(0);
    expect(otherRepaired).toBeLessThanOrEqual(1);
    expect(performance.now() - started).toBeLessThan(6500);
    expect(poolSnapshot(pool)).toEqual({ inUse: 1, waiting: 0 });
    expect(await pool<{ id: string }[]>`SELECT r.id FROM control.runs r JOIN control.invocation_tokens t ON t.run_id=r.id
      WHERE r.invocation_deployment_id=${f.deploymentId} AND t.expires_at>clock_timestamp()`).toEqual([]);
    expect(await pool<{ kind: string }[]>`SELECT e.kind FROM audit.events e JOIN control.runs r ON r.id=e.run_id
      WHERE r.invocation_deployment_id=${f.deploymentId} AND e.kind LIKE 'function.%'`).toEqual([]);
    const fairDeadline = performance.now() + 2000;
    do {
      otherRepaired += await reconcileInvocations(pool);
      if (!otherRepaired) await Bun.sleep(20);
    } while (!otherRepaired && performance.now() < fairDeadline);
    expect(otherRepaired).toBe(1);
    expect(await pool<{ kind: string }[]>`SELECT kind FROM audit.events WHERE run_id=${healthy.runIds[0]!}`).toEqual([{ kind: "function.fail" }]);
    release.resolve(); await blocker;
    // Socket close can settle before PostgreSQL releases that backend's advisory lock.
    const repairDeadline = performance.now() + 2000;
    let repaired = 0;
    do {
      repaired += await reconcileInvocations(pool);
      if (repaired < 6) await Bun.sleep(20);
    } while (repaired < 6 && performance.now() < repairDeadline);
    expect(repaired).toBe(6);
    const runId = f.runIds[0]!;
    const before = await pool<{ kind: string; metadata: unknown }[]>`SELECT kind,metadata FROM audit.events WHERE run_id=${runId} AND kind LIKE 'function.%'`;
    expect(before[0]?.kind).toBe("function.fail");
    await finishInvocation(pool, runId, "function.complete", 1, 200);
    expect(await pool<{ kind: string; metadata: unknown }[]>`SELECT kind,metadata FROM audit.events WHERE run_id=${runId} AND kind LIKE 'function.%'`).toEqual(before);
    expect(await reconcileInvocations(pool)).toBe(0);
  } finally { release.resolve(); await blocker; await pool.close(); }
}, 15000);


test("schema upgrade backfills unfinished invocations and preserves closed-definer authority and settling delay", async () => {
  const database = await migratedDatabase(undefined, 33), pool = createPool(database), admin = new SQL(adminUrl(database));
  try {
    const f = await orphanFixture(pool, 2);
    await finishInvocation(pool, f.runIds[0]!, "function.complete", 1, 200);
    const migrations = await loadMigrations(new URL("../../../db/migrations", import.meta.url).pathname);
    await migrate(sqlMigrationRunner(admin), migrations);
    expect(await pool<{ runId: string }[]>`SELECT run_id AS "runId" FROM control.invocation_pending`).toEqual([{ runId: f.runIds[1]! }]);
    const functions = await admin<{ secure: boolean; config: string[]; owner: string }[]>`SELECT prosecdef AS secure,proconfig AS config,proowner::regrole::text AS owner FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='control' AND p.proname IN ('create_invocation','finish_invocation')`;
    expect(functions).toHaveLength(2);
    for (const fn of functions) { expect(fn.secure).toBe(true); expect(fn.owner).toBe("bp_audit"); expect(fn.config).toContain("search_path=pg_catalog"); }
    await expect(Promise.resolve(pool`DELETE FROM control.invocation_pending`)).rejects.toThrow("permission denied");
    await admin.begin(async tx => {
      await tx`SET LOCAL ROLE bp_executor`;
      await expect(Promise.resolve(tx`SELECT control.create_invocation(${f.deploymentId},${randomBytes(32)},1)`)).rejects.toThrow("permission denied");
    }).catch(error => { if (!String(error).includes("current transaction is aborted")) throw error; });
    await admin.begin(async tx => {
      await tx`SET LOCAL ROLE bp_executor`;
      await expect(Promise.resolve(tx`SELECT control.finish_invocation(${f.runIds[1]!},'function.fail',1,NULL)`)).rejects.toThrow("permission denied");
    }).catch(error => { if (!String(error).includes("current transaction is aborted")) throw error; });
    expect(await reconcileInvocations(pool)).toBe(0);
    await agePending(database);
    expect(await reconcileInvocations(pool)).toBe(1);
    expect(await pool<{ run_id: string }[]>`SELECT run_id FROM control.invocation_pending`).toEqual([]);
    const fresh = await orphanFixture(pool, 1, f.fixture);
    expect(await pool<{ runId: string }[]>`SELECT run_id AS "runId" FROM control.invocation_pending`).toEqual([{ runId: fresh.runIds[0]! }]);
    expect(await reconcileInvocations(pool)).toBe(0);
    await finishInvocation(pool, fresh.runIds[0]!, "function.timeout", 1, null);
    expect(await pool<{ run_id: string }[]>`SELECT run_id FROM control.invocation_pending`).toEqual([]);
    expect(await reconcileInvocations(pool)).toBe(0);
  } finally { await admin.close(); await pool.close(); }
});
