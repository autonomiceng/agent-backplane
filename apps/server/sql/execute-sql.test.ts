import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { adminUrl } from "../testing/postgres.ts";
import { createRun, issueKey, sqlFixture } from "../testing/session.ts";
import { workspaceTable } from "../testing/workspace.ts";
import type { SqlResponse } from "./execute-sql-input.ts";

const ddl = "CREATE TABLE items (id int PRIMARY KEY CHECK (id > 0), note text NOT NULL)";

async function successful(response: Response): Promise<SqlResponse> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return await response.json() as SqlResponse;
}

test("protected-schema access exposes audit, control, catalog or another Workspace while own-table parameters become SQL", async () => {
  const { pool, app, cookie, url, workspaceId, principalId, runId, sql } = await sqlFixture(ddl);
  try {
    const payload = "private'); RESET ROLE; --";
    expect(await successful(await sql("INSERT INTO items (id, note) VALUES ($1, $2) RETURNING *", [1, payload])))
      .toEqual({ rows: [{ id: 1, note: payload, principal_id: principalId, run_id: runId }], rowCount: "1", truncated: false });
    expect(await successful(await sql("SELECT id, note FROM items WHERE id = $1; -- trailing delimiter", [1])))
      .toEqual({ rows: [{ id: 1, note: payload }], rowCount: "1", truncated: false });
    const foreign = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Foreign" }),
    }));
    expect(foreign.status).toBe(201);
    const foreignId = (await foreign.json() as { id: string }).id;
    await workspaceTable(url, foreignId, ddl);
    await workspaceTable(url, workspaceId, "CREATE TABLE unstamped (id int)");
    const admin = createPool(adminUrl(url));
    try {
      await admin.begin(async (tx) => {
        const schema = `ws_${workspaceId.replaceAll("-", "")}`;
        await tx`SET LOCAL ROLE bp_executor`;
        await tx.unsafe(`DROP TRIGGER bp_stamp ON "${schema}".unstamped`);
        await tx.unsafe(`CREATE VIEW "${schema}".items_view AS SELECT * FROM "${schema}".items`);
        await tx.unsafe(`GRANT SELECT ON "${schema}".items_view TO "bp_ws_${workspaceId.replaceAll("-", "")}"`);
      });
    } finally { await admin.close(); }
    const before = await pool`SELECT position FROM audit.events WHERE kind = 'sql.execute' AND workspace_id = ${workspaceId}`;
    for (const statement of ["SELECT * FROM audit.events", "SELECT * FROM control.principals",
      `SELECT * FROM ws_${foreignId.replaceAll("-", "")}.items`, "SELECT * FROM pg_roles"]) {
      const response = await sql(statement);
      expect([403, 422]).toContain(response.status);
      expect(await response.json()).toEqual({ error: "sql_statement_forbidden" });
    }
    for (const statement of ["SELECT * FROM unstamped", "SELECT * FROM items_view"]) {
      const response = await sql(statement);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "sql_relation_contract" });
    }
    expect(await pool`SELECT position FROM audit.events WHERE kind = 'sql.execute' AND workspace_id = ${workspaceId}`).toEqual(before);
    const unknown = await sql("SELECT missing FROM items");
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toEqual({ error: "sql_unknown_object", sqlstate: "42703" });
    const typed = await successful(await sql("SELECT $1::int8 AS big, $2::numeric AS decimal, $3::timestamptz AS at", [
      "9007199254740993", "1234567890.123456789", "2026-01-01T00:00:00Z",
    ]));
    expect(typed.rows).toEqual([{ big: Number("9007199254740993"), decimal: Number("1234567890.123456789"), at: "2026-01-01T00:00:00+00:00" }]);
  } finally { await pool.close(); }
});

test("privilege escalation accepts role changes or audit calls and pooled role leakage survives the transaction", async () => {
  const { pool, workspaceId, sql } = await sqlFixture(ddl);
  try {
    for (const statement of ["RESET ROLE", "SET ROLE bp_server", "SELECT set_config('role', 'bp_server', true)",
      "SELECT audit.emit('token', 'forged', NULL, 0, '{}'::jsonb)"]) {
      const response = await sql(statement);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "sql_statement_forbidden" });
    }
    expect(await pool`SELECT position FROM audit.events WHERE kind = 'sql.execute'`).toHaveLength(0);
    expect(await pool<{ reason: string }[]>`SELECT reason FROM audit.rejections WHERE workspace_id = ${workspaceId}`)
      .toEqual(Array.from({ length: 4 }, () => ({ reason: "sql_statement_forbidden" })));
    await successful(await sql("SELECT 1 AS value"));
    expect(await pool.begin((tx) => tx<{ name: string }[]>`SELECT current_user AS name`)).toEqual([{ name: "bp_server" }]);
    await expect(pool.begin((tx) => tx`SELECT audit.emit('unbound', 'forged', ARRAY[]::text[], 0, '{}'::jsonb)`))
      .rejects.toThrow("context_missing");
    const failed = await sql("SELECT 1 / 0");
    expect(failed.status).toBe(422);
    expect(await failed.json()).toEqual({ error: "sql_error", sqlstate: "22012" });
    expect(await pool.begin((tx) => tx<{ name: string }[]>`SELECT current_user AS name`)).toEqual([{ name: "bp_server" }]);
    expect(await pool<{ kind: string }[]>`SELECT kind FROM audit.events WHERE kind IN ('sql.execute', 'forged')`).toEqual([{ kind: "sql.execute" }]);
  } finally { await pool.close(); }
});

test("missing row attribution preserves spoofed stamps or loses the deleting Run and a failed write survives rollback", async () => {
  const { pool, app, cookie, workspaceId, principalId, runId, sql } = await sqlFixture(
    "CREATE TABLE items (id int PRIMARY KEY CHECK (id > 0), note text NOT NULL, metadata jsonb, payload bytea)",
  );
  try {
    const other = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Second" }),
    }));
    expect(other.status).toBe(201);
    const otherId = (await other.json() as { id: string }).id;
    const otherKey = await issueKey(app, cookie, workspaceId, otherId);
    const otherRun = await createRun(app, otherKey, workspaceId);
    const second = { key: otherKey, runId: otherRun };
    const secret = "parameter-must-never-enter-audit";
    const metadata = { nested: [1, true, null], note: secret };
    const payload = "\\x00ff80";
    const inserted = await successful(await sql(
      "INSERT INTO items (id, note, principal_id, run_id, metadata, payload) VALUES (1, $1, $2, $3, $4::jsonb, $5) RETURNING *",
      [secret, otherId, otherRun, metadata, payload],
    ));
    expect(inserted.rows).toEqual([{ id: 1, note: secret, principal_id: principalId, run_id: runId, metadata, payload }]);
    const updated = await successful(await sql("UPDATE items SET note = $1, principal_id = $2, run_id = $3 WHERE id = 1 RETURNING *",
      [secret, principalId, runId], second));
    expect(updated.rows).toEqual([{ id: 1, note: secret, principal_id: otherId, run_id: otherRun, metadata, payload }]);
    expect((await successful(await sql("SELECT * FROM items"))).rows).toEqual(updated.rows);
    expect(await successful(await sql("DELETE FROM items WHERE id = 1", [], second)))
      .toEqual({ rows: [], rowCount: "1", truncated: false });
    expect((await successful(await sql("SELECT * FROM items"))).rows).toEqual([]);
    const events = await pool<{ principal_id: string; run_id: string; objects: string[]; row_count: string; metadata: string }[]>`
      SELECT principal_id, run_id, objects, row_count::text, metadata::text FROM audit.events
      WHERE kind = 'sql.execute' AND workspace_id = ${workspaceId} ORDER BY position`;
    expect(events[3]).toMatchObject({ principal_id: otherId, run_id: otherRun, objects: ["items"], row_count: "1" });
    for (const event of events) {
      expect(event.objects).toEqual(["items"]);
      expect(event.metadata).not.toContain(secret);
      expect(Object.keys(JSON.parse(event.metadata)).sort()).toEqual(["fingerprint", "kind"]);
    }
    const failed = await sql("INSERT INTO items (id, note) VALUES (2, $1), (-1, $1)", [secret]);
    expect(failed.status).toBe(422);
    expect(await failed.json()).toEqual({ error: "sql_error", sqlstate: "23514" });
    expect(await pool`SELECT position FROM audit.events WHERE kind = 'sql.execute' AND workspace_id = ${workspaceId}`).toHaveLength(events.length);
    expect(await pool<{ reason: string; sqlstate: string }[]>`SELECT reason, sqlstate FROM audit.rejections WHERE workspace_id = ${workspaceId}`)
      .toEqual([{ reason: "sql_error", sqlstate: "23514" }]);
    expect((await successful(await sql("SELECT * FROM items"))).rows).toEqual([]);
  } finally { await pool.close(); }
});

test("unbounded execution or results bypass the row cap, mutation count, lock deadline or oversized-result rollback", async () => {
  const { pool, url, workspaceId, sql } = await sqlFixture(ddl);
  const admin = createPool(adminUrl(url));
  try {
    const sleep = await sql("SELECT pg_sleep(3)");
    expect(sleep.status).toBe(422);
    expect(await sleep.json()).toEqual({ error: "sql_statement_forbidden" });
    const series = await sql("SELECT * FROM generate_series(1, 1000000) a CROSS JOIN generate_series(1, 1000000) b");
    expect(series.status).toBe(422);
    expect(await series.json()).toEqual({ error: "sql_statement_forbidden" });
    expect((await successful(await sql(`INSERT INTO items (id, note) VALUES ${Array.from({ length: 1500 }, (_, i) => `(${i + 1}, 'initial')`).join(",")}`))).rowCount)
      .toBe("1500");
    const selected = await successful(await sql("SELECT id FROM items ORDER BY id"));
    expect(selected.rows).toHaveLength(1000);
    expect(selected.rows.at(-1)).toEqual({ id: 1000 });
    expect(selected).toMatchObject({ rowCount: "1000", truncated: true });
    expect(await successful(await sql("UPDATE items SET note = $1", ["updated"])))
      .toEqual({ rows: [], rowCount: "1500", truncated: false });
    const returning = await successful(await sql("UPDATE items SET note = 'updated' RETURNING id"));
    expect(returning.rows).toHaveLength(1000);
    expect(returning).toMatchObject({ rowCount: "1500", truncated: true });
    expect((await successful(await sql("SELECT count(*) AS total FROM items WHERE note = 'updated'"))).rows).toEqual([{ total: 1500 }]);
    const expensive = await sql("SELECT count(*) FROM items a CROSS JOIN items b CROSS JOIN items c CROSS JOIN items d");
    expect(expensive.status).toBe(408);
    expect(await expensive.json()).toEqual({ error: "sql_statement_timeout", sqlstate: "57014" });

    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // This transaction only holds a row lock. All fixture data and mutations go through the API.
    const holder = admin.begin(async (tx) => {
      await tx.unsafe(`SELECT id FROM "ws_${workspaceId.replaceAll("-", "")}".items WHERE id = 1 FOR UPDATE`);
      locked.resolve();
      await release.promise;
    });
    try {
      await Promise.race([locked.promise, holder]);
      const started = performance.now();
      const waiting = await sql("UPDATE items SET note = 'blocked' WHERE id = 1");
      expect(performance.now() - started).toBeLessThan(2000);
      expect(waiting.status).toBe(408);
      expect(await waiting.json()).toEqual({ error: "sql_lock_timeout", sqlstate: "55P03" });
    } finally { release.resolve(); await holder; }
    const before = await pool`SELECT position FROM audit.events WHERE kind = 'sql.execute' AND workspace_id = ${workspaceId}`;
    const oversized = await sql("UPDATE items SET note = $1 WHERE id = 1 RETURNING note", ["x".repeat(1024 * 1024)]);
    expect(oversized.status).toBe(422);
    expect(await oversized.json()).toEqual({ error: "sql_result_too_large" });
    expect(await pool`SELECT position FROM audit.events WHERE kind = 'sql.execute' AND workspace_id = ${workspaceId}`).toEqual(before);
    expect((await successful(await sql("SELECT note FROM items WHERE id = 1"))).rows).toEqual([{ note: "updated" }]);
    expect(await pool<{ reason: string }[]>`SELECT reason FROM audit.rejections WHERE workspace_id = ${workspaceId} AND reason = 'sql_result_too_large'`)
      .toEqual([{ reason: "sql_result_too_large" }]);
  } finally { await admin.close(); await pool.close(); }
}, 10000);
