import { expect, test } from "bun:test";
import { createPool } from "./pool.ts";
import { defaultQuotas } from "./quotas.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { applyMigration, createRun, queueFixture } from "../testing/session.ts";

test("Concurrent SQL requests overshoot a shared Principal quota", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url), admin = createPool(adminUrl(url));
  try {
    const f = await queueFixture(pool);
    await applyMigration(f.app, f.key, f.runId, f.workspaceId, "CREATE TABLE items (id int)");
    const run = await createRun(f.app, f.key, f.workspaceId);
    const base = `http://localhost/api/v1/workspaces/${f.workspaceId}`;
    const put = (settings: typeof defaultQuotas) => f.app.handle(new Request(`${base}/quotas`, {
      method: "PUT", headers: { origin: "http://localhost", cookie: f.cookie, "content-type": "application/json" }, body: JSON.stringify(settings),
    }));
    const post = (path: string, body: unknown, runId = f.runId) => f.app.handle(new Request(`${base}${path}`, {
      method: "POST", headers: { ...f.headers, "x-backplane-run": runId }, body: JSON.stringify(body),
    }));
    const statement = "INSERT INTO items VALUES (1)";
    const bytes = Buffer.byteLength(statement);
    expect((await put({ ...defaultQuotas, sql_statement_bytes: bytes * 3 })).status).toBe(200);
    const [clock] = await admin`SELECT extract(second FROM clock_timestamp())::float AS seconds`;
    if (clock.seconds > 45) await Bun.sleep((60 - clock.seconds) * 1000 + 50);
    const [window] = await admin`SELECT date_trunc('minute', clock_timestamp()) AS start`;
    const replies = await Promise.all(Array.from({ length: 6 }, (_, i) => post("/sql", { statement, params: [] }, i % 2 ? run : f.runId)));
    expect(replies.filter((r) => r.status === 200)).toHaveLength(3);
    expect(replies.filter((r) => r.status === 429)).toHaveLength(3);
    for (const reply of replies.filter((r) => r.status === 429)) {
      const body = await reply.json();
      expect(body).toMatchObject({ error: "quota_exceeded", resource: "sql_statement_bytes", limit: bytes * 3,
        window: { start: window.start.toISOString(), end: new Date(window.start.getTime() + 60000).toISOString() } });
      expect(reply.headers.get("retry-after")).toBe(String(body.retryAfterSeconds));
      expect(reply.headers.get("cache-control")).toBe("no-store");
    }
    const usage = () => admin<{ resource: string; used: string; window_start: Date }[]>`SELECT resource, used::text, window_start FROM control.quota_usage
      WHERE workspace_id = ${f.workspaceId} AND principal_id = ${f.principalId} ORDER BY resource`;
    expect(await usage()).toEqual([
      { resource: "sql_rows", used: "3", window_start: window.start },
      { resource: "sql_statement_bytes", used: String(bytes * 3), window_start: window.start },
    ]);
    expect((await post("/transactions", { idempotencyKey: "blocked", operations: [{ sql: { statement, params: [] } }] })).status).toBe(429);
    expect((await put({ ...defaultQuotas, sql_rows: 3 })).status).toBe(200);
    expect((await post("/sql", { statement, params: [] })).status).toBe(429);
    const afterRollback = await usage();
    expect(afterRollback.find((r) => r.resource === "sql_statement_bytes")?.used).toBe(String(bytes * 3));
    expect((await put(defaultQuotas)).status).toBe(200);
    const handoff = { idempotencyKey: "committed", operations: [{ sql: { statement, params: [] } },
      { send: { queue: f.queue, idempotencyKey: "send", payload: {} } }] };
    expect((await post("/transactions", handoff)).status).toBe(200);
    const committed = await usage();
    expect(committed.map((r) => [r.resource, r.used])).toEqual([
      ["queue_sends", "1"], ["sql_rows", "4"], ["sql_statement_bytes", String(bytes * 4)], ["transaction_operations", "2"],
    ]);
    expect((await post("/transactions", handoff)).status).toBe(200);
    expect((await post(`/queues/${f.queue}/messages`, { idempotencyKey: "send", payload: {} })).status).toBe(200);
    expect(await usage()).toEqual(committed);
    expect((await put({ ...defaultQuotas, queue_sends: 1 })).status).toBe(200);
    expect((await post(`/queues/${f.queue}/messages`, { idempotencyKey: "over-quota", payload: {} })).status).toBe(429);
    const rejections = await admin`SELECT reason FROM audit.rejections WHERE workspace_id = ${f.workspaceId}
      AND principal_id = ${f.principalId} AND run_id = ${f.runId} AND kind = 'queue.send'`;
    expect(rejections).toEqual([{ reason: "quota_exceeded" }]);
    const read = await post("/sql", { statement: "SELECT count(*)::int AS n FROM items", params: [] });
    expect((await read.json()).rows).toEqual([{ n: 4 }]);
    const events = await admin<{ kind: string; user_id: string | null; principal_id: string | null; run_id: string | null }[]>`SELECT principal_id, run_id FROM audit.events WHERE workspace_id = ${f.workspaceId} AND kind = 'sql.execute'`;
    expect(events.length).toBe(5);
    expect(events.every((e) => e.principal_id === f.principalId && [run, f.runId].includes(e.run_id ?? ""))).toBe(true);
    expect((await put({ ...defaultQuotas, sql_statement_bytes: bytes })).status).toBe(200);
    expect((await post("/sql", { statement, params: [] })).status).toBe(429);
    const [previous] = await admin<{ start: Date; now: Date }[]>`SELECT date_trunc('minute', clock_timestamp()) AS start, clock_timestamp() AS now`;
    if (!previous) throw new Error("database clock unavailable");
    let fresh = previous.start;
    while (fresh.getTime() === previous.start.getTime()) {
      await Bun.sleep(100);
      const [clock] = await admin<{ start: Date; now: Date }[]>`SELECT date_trunc('minute', clock_timestamp()) AS start, clock_timestamp() AS now`;
      if (!clock || clock.now.getTime() - previous.now.getTime() > 61000) throw new Error("database minute did not advance");
      fresh = clock.start;
    }
    expect((await post("/sql", { statement, params: [] })).status).toBe(200);
    const replaced = await usage();
    expect(replaced.filter((row) => row.resource.startsWith("sql_"))).toEqual([
      { resource: "sql_rows", used: "1", window_start: fresh },
      { resource: "sql_statement_bytes", used: String(bytes), window_start: fresh },
    ]);
  } finally { await Promise.all([pool.close(), admin.close()]); }
}, 90000);
