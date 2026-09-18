import { runSession } from "../runs/run-session.ts";
import { expect, test } from "bun:test";
import { createPool } from "./pool.ts";
import { defaultQuotas } from "./quotas.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { applyMigration, queueFixture } from "../testing/session.ts";

test("Exhausted Principal quota prevents User recovery", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url), admin = createPool(adminUrl(url));
  try {
    const f = await queueFixture(pool);
    await applyMigration(f.app, f.key, f.runId, f.workspaceId, "CREATE TABLE items (id int)");
    const base = `http://localhost/api/v1/workspaces/${f.workspaceId}`;
    const headers = { origin: "http://localhost", cookie: f.cookie, "content-type": "application/json" };
    const put = (body: unknown, workspace = f.workspaceId) => f.app.handle(new Request(`http://localhost/api/v1/workspaces/${workspace}/quotas`, {
      method: "PUT", headers, body: JSON.stringify(body),
    }));
    const statement = "INSERT INTO items VALUES (1)";
    const sql = () => f.app.handle(new Request(`${base}/sql`, { method: "POST", headers: f.headers, body: JSON.stringify({ statement, params: [] }) }));
    expect((await put({ ...defaultQuotas, sql_rows: 1, sql_statement_bytes: Buffer.byteLength(statement) })).status).toBe(200);
    const [clock] = await admin`SELECT extract(second FROM clock_timestamp())::float AS seconds`;
    if (clock.seconds > 45) await Bun.sleep((60 - clock.seconds) * 1000 + 50);
    expect((await sql()).status).toBe(200);
    expect((await sql()).status).toBe(429);
    const usage = () => admin<{ resource: string; used: string; window_start: Date }[]>`SELECT resource, used::text, window_start FROM control.quota_usage WHERE workspace_id = ${f.workspaceId} ORDER BY resource`;
    const before = await usage();
    // One of the six admission permits is reserved for invocation callbacks, so five ordinary handlers admit.
    const waiterResolved = Promise.withResolvers<void>();
    const app = f.app.use(runSession(pool)).post("/api/v1/workspaces/:workspaceId/admission-probe", async () => {
      await pool.begin(async (tx) => {
        await tx`SET TRANSACTION READ ONLY`;
        await tx`SET LOCAL statement_timeout = 10000`;
        await tx`SELECT count(*) FROM queue.messages /* quota_admission */`;
      });
      return { ok: true };
    }, { run: true, beforeHandle({ request }) {
      if (request.headers.has("x-test-waiter")) waiterResolved.resolve();
    } }).compile();
    const probe = (actorHeaders: Record<string, string> = f.headers) => app.handle(new Request(`${base}/admission-probe`, { method: "POST", headers: actorHeaders }));
    const locked = Promise.withResolvers<void>(), unlock = Promise.withResolvers<void>();
    const blocker = admin.begin(async (tx) => {
      await tx`LOCK TABLE queue.messages IN ACCESS EXCLUSIVE MODE`;
      locked.resolve(); await unlock.promise;
    });
    const traffic: Promise<Response>[] = [];
    try {
      await locked.promise;
      traffic.push(...Array.from({ length: 5 }, () => probe()));
      const deadline = performance.now() + 3000;
      while (true) {
        const [state] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND usename = 'bp_server' AND wait_event_type = 'Lock'
            AND query LIKE '%quota_admission%'`;
        if (state?.count === 5) break;
        if (performance.now() > deadline) throw new Error("five authenticated handlers did not reach the table lock");
        await Bun.sleep(10);
      }
      const fabricated = { ...f.headers, authorization: `Bearer bp_${"0".repeat(24)}_${"0".repeat(64)}` };
      expect((await probe(fabricated)).status).toBe(401);
      expect((await probe({ ...f.headers, "x-backplane-run": crypto.randomUUID() })).status).toBe(403);
      const started = performance.now();
      const refused = await probe();
      expect(refused.status).toBe(503);
      expect(await refused.json()).toEqual({ error: "admission_unavailable" });
      expect(performance.now() - started).toBeGreaterThanOrEqual(1900);
      expect((await put({ ...defaultQuotas, sql_rows: 1 })).status).toBe(200);
      expect((await app.handle(new Request("http://localhost/health/ready"))).status).toBe(200);
      expect(await usage()).toEqual(before);
      const waiter = probe({ ...f.headers, "x-test-waiter": "true" });
      traffic.push(waiter);
      await waiterResolved.promise;
      unlock.resolve(); await blocker;
      expect((await waiter).status).toBe(200);
      expect((await Promise.all(traffic)).every((r) => r.status === 200)).toBe(true);
    } finally { unlock.resolve(); await Promise.allSettled([blocker, ...traffic]); }
    expect((await put({ ...defaultQuotas, sql_rows: 1 })).status).toBe(200);
    expect((await f.app.handle(new Request(`${base}/principals/${f.principalId}/revoke`, { method: "POST", headers }))).status).toBe(200);
    expect((await sql()).status).toBe(401);
    expect(await usage()).toEqual(before);
    expect((await put(defaultQuotas, crypto.randomUUID())).status).toBe(403);
    expect((await put({ ...defaultQuotas, sql_rows: -1 })).status).toBe(422);
    expect((await put({ ...defaultQuotas, extra: 1 })).status).toBe(422);
    expect((await put({ sql_rows: 1 })).status).toBe(422);
    const events = await admin<{ kind: string; user_id: string | null; principal_id: string | null; run_id: string | null }[]>`SELECT kind, user_id, principal_id, run_id FROM audit.events
      WHERE workspace_id = ${f.workspaceId} AND kind IN ('quota.updated', 'principal.revoked') ORDER BY position`;
    expect(events.map((e) => e.kind)).toEqual(["quota.updated", "quota.updated", "principal.revoked"]);
    expect(events.every((e) => e.user_id !== null && e.principal_id === null && e.run_id === null)).toBe(true);
    expect(new Set(events.map((e) => e.user_id)).size).toBe(1);
  } finally { await Promise.all([pool.close(), admin.close()]); }
}, 60000);
