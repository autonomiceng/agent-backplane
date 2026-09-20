import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createPool, poolSnapshot, type Pool } from "../platform/pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { principalFixture, issueKey, createRun, testApp } from "../testing/session.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { finishInvocation } from "./finish-invocation.ts";
import { reconcileInvocations, scheduleInvocationReconciliation } from "./reconcile-invocations.ts";

async function orphanFixture(pool: Pool, count: number) {
  const f = await principalFixture(pool);
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
  return { caller, runIds, deploymentId: id };
}

test("reconciler shutdown cancels saturated reservations and late passes for only its own pool", async () => {
  const database = await migratedDatabase(), pool = createPool(database, 1), other = createPool(database);
  let held: Awaited<ReturnType<typeof pool.reserve>> | undefined, stop: (() => Promise<void>) | undefined;
  try {
    const f = await orphanFixture(other, 1);
    held = await pool.reserve();
    stop = scheduleInvocationReconciliation(pool);
    expect(poolSnapshot(pool)).toEqual({ inUse: 1, waiting: 1 });
    const started = performance.now(); await stop();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(poolSnapshot(pool)).toEqual({ inUse: 1, waiting: 0 });
    expect(await reconcileInvocations(pool)).toBe(0);
    expect(poolSnapshot(pool)).toEqual({ inUse: 1, waiting: 0 });
    expect(await reconcileInvocations(other)).toBe(1);
    expect(await other<{ kind: string }[]>`SELECT kind FROM audit.events WHERE run_id=${f.runIds[0]!} AND kind LIKE 'function.%'`).toEqual([{ kind: "function.fail" }]);
  } finally { await stop?.(); held?.release(); await pool.close(); await other.close(); }
});

test("a contended recovery batch releases its connection within five seconds and later repairs immutable terminals", async () => {
  const pool = createPool(await migratedDatabase());
  const release = Promise.withResolvers<void>(), acquired = Promise.withResolvers<void>();
  let blocker: Promise<unknown> | undefined;
  try {
    // Twelve orphans exceed the pass budget at the real 250ms audit-lock timeout.
    const f = await orphanFixture(pool, 12);
    blocker = withRunContext(pool, f.caller, async () => { acquired.resolve(); await release.promise; });
    await acquired.promise;
    const started = performance.now();
    expect(await reconcileInvocations(pool)).toBe(0);
    expect(performance.now() - started).toBeLessThan(6500);
    expect(poolSnapshot(pool)).toEqual({ inUse: 1, waiting: 0 });
    expect(await pool<{ id: string }[]>`SELECT r.id FROM control.runs r JOIN control.invocation_tokens t ON t.run_id=r.id
      WHERE r.invocation_deployment_id=${f.deploymentId} AND t.expires_at>clock_timestamp()`).toEqual([]);
    expect(await pool<{ kind: string }[]>`SELECT e.kind FROM audit.events e JOIN control.runs r ON r.id=e.run_id
      WHERE r.invocation_deployment_id=${f.deploymentId} AND e.kind LIKE 'function.%'`).toEqual([]);
    release.resolve(); await blocker;
    // Socket close can settle before PostgreSQL releases that backend's advisory lock.
    const repairDeadline = performance.now() + 2000;
    let repaired = 0;
    do {
      repaired += await reconcileInvocations(pool);
      if (repaired < 12) await Bun.sleep(20);
    } while (repaired < 12 && performance.now() < repairDeadline);
    expect(repaired).toBe(12);
    const runId = f.runIds[0]!;
    const before = await pool<{ kind: string; metadata: unknown }[]>`SELECT kind,metadata FROM audit.events WHERE run_id=${runId} AND kind LIKE 'function.%'`;
    expect(before[0]?.kind).toBe("function.fail");
    await finishInvocation(pool, runId, "function.complete", 1, 200);
    expect(await pool<{ kind: string; metadata: unknown }[]>`SELECT kind,metadata FROM audit.events WHERE run_id=${runId} AND kind LIKE 'function.%'`).toEqual(before);
    expect(await reconcileInvocations(pool)).toBe(0);
  } finally { release.resolve(); await blocker; await pool.close(); }
}, 15000);
