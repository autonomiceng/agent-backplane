import { expect, test } from "bun:test";
import { applyMigration, createRun, transactionFixture } from "../testing/session.ts";
import type { RowDescriptor } from "./gate-policy.ts";
import type { AuditPage } from "../events/read-audit-input.ts";
import type { Claim } from "../queue/claim-input.ts";
import type { TransactionInput } from "../tx/execute-transaction-input.ts";

type Proposal = { statement: string; params: (number | string)[]; expectRows: 1 };
async function body<T = Record<string, unknown>>(response: Response, status = 200): Promise<NoInfer<T>> {
  const value: unknown = await response.json();
  expect({ status: response.status, ...(response.status === status ? {} : { body: value }) }).toEqual({ status });
  return value as T;
}
const proposal = (expression = "updates + 1", id = 1): Proposal => ({
  statement: `UPDATE items SET updates = ${expression} WHERE id = $1`, params: [id], expectRows: 1,
});
async function fixture() {
  const f = await transactionFixture(2);
  const userHeaders = { origin: "http://localhost", cookie: f.cookie, "content-type": "application/json" };
  const gate = (enabled = true, headers: Record<string, string> = userHeaders, selector = "items") => f.app.handle(new Request(`${f.baseUrl}/approvals/gates`, {
    method: "PUT", headers, body: JSON.stringify({ targetKind: "row", selector, enabled }),
  }));
  const descriptor = async (sql: Proposal) => {
    const denied = await body<{ error: string; target: RowDescriptor }>(await f.post("/sql", { statement: sql.statement, params: sql.params }), 422);
    expect(denied.error).toBe("approval_required");
    return denied.target;
  };
  const request = async (sql: Proposal, target?: RowDescriptor, expiresInSeconds = 3600) => {
    const { table, primaryKey, targetVersion } = target ?? await descriptor(sql);
    return body<{ id: string }>(await f.post("/approvals", { targetKind: "row", table, primaryKey, targetVersion, sql, expiresInSeconds }), 201);
  };
  const decide = (id: string) => f.post(`/approvals/${id}/decision`, { decision: "approve", reason: "reviewed" }, userHeaders);
  const approved = async (sql: Proposal, target?: RowDescriptor, expiresInSeconds = 3600) => {
    const approval = await request(sql, target, expiresInSeconds);
    expect(await body(await decide(approval.id))).toEqual({ id: approval.id, decision: "approve", releasedDeliveryId: null });
    return approval.id;
  };
  const execute = (sql: Proposal, approvalId?: string, idempotencyKey = crypto.randomUUID()) =>
    f.post("/transactions", { idempotencyKey, operations: [{ sql: { ...sql, ...(approvalId ? { approvalId } : {}) } }] });
  const rows = async () => (await body<{ rows: { id: number; updates: number }[] }>(await f.post("/sql", {
    statement: "SELECT id, updates FROM items ORDER BY id", params: [],
  }))).rows;
  const audit = async () => (await body<AuditPage>(await f.app.handle(new Request(`${f.baseUrl}/audit?limit=500`, { headers: f.headers })))).events;
  return { ...f, gate, descriptor, request, decide, approved, execute, rows, audit };
}

test("changed target or substituted proposal is accepted after no-op, ABA, epoch, revision or expiry", async () => {
  const f = await fixture();
  try {
    const initialGate = await body(await f.gate());
    expect(await body(await f.gate())).toEqual(initialGate);
    const sql = proposal("updates"), target = await f.descriptor(sql);
    expect(await body(await f.post("/approvals", { targetKind: "row", table: target.table,
      primaryKey: { id: 2 }, targetVersion: target.targetVersion, sql }), 409)).toEqual({ error: "approval_mismatch" });
    const first = await f.approved(sql, target), stale = await f.approved(sql, target);
    expect(await body(await f.execute({ ...sql, params: [2] }, first), 409)).toMatchObject({ error: "approval_mismatch" });
    expect(await body(await f.execute(proposal("99"), first), 409)).toMatchObject({ error: "approval_mismatch" });
    expect(await body(await f.post("/transactions", { idempotencyKey: "same-transaction-staleness", operations: [
      { sql: { ...sql, approvalId: first } }, { sql: { ...sql, approvalId: stale } },
    ] }), 409)).toEqual({ error: "approval_stale", operationIndex: 1 });
    await body(await f.execute(sql, first));
    expect((await f.descriptor(sql)).targetVersion).not.toBe(target.targetVersion);
    expect(await body(await f.execute(sql, stale), 409)).toMatchObject({ error: "approval_stale" });
    const old = await f.approved(sql);
    const pending = await f.request(sql);
    const toB = proposal("1"), toA = proposal("0");
    await body(await f.execute(toB, await f.approved(toB)));
    await body(await f.execute(toA, await f.approved(toA)));
    expect((await f.rows())[0]?.updates).toBe(0);
    expect(await body(await f.execute(sql, old), 409)).toMatchObject({ error: "approval_stale" });
    expect(await body(await f.decide(pending.id), 409)).toEqual({ error: "approval_stale" });
    const epoch = await f.approved(sql);
    await body(await f.gate(false));
    expect((await body(await f.gate())).epoch).not.toBe(initialGate.epoch);
    expect(await body(await f.execute(sql, epoch), 409)).toMatchObject({ error: "approval_stale" });
    const revision = await f.approved(sql);
    await applyMigration(f.app, f.key, f.runId, f.workspaceId, "CREATE TABLE other (id int PRIMARY KEY)", 1);
    expect(await body(await f.execute(sql, revision), 409)).toMatchObject({ error: "approval_stale" });
    const expiring = await f.approved(sql, undefined, 1);
    await f.pool`SELECT pg_sleep(1.05)`;
    expect(await body(await f.execute(sql, expiring), 409)).toMatchObject({ error: "approval_expired" });
    expect((await f.audit()).filter((event) => event.kind === "approval.gate")).toHaveLength(3);
    await applyMigration(f.app, f.key, f.runId, f.workspaceId,
      "CREATE TABLE exact_keys (id bigint, part numeric, updates int NOT NULL, PRIMARY KEY (id, part))", 2);
    await body(await f.post("/sql", { statement: "INSERT INTO exact_keys (id, part, updates) VALUES ($1, $2, 0)",
      params: ["9007199254740993", "1.00"] }));
    await body(await f.gate(true, undefined, "exact_keys"));
    const precise: Proposal = { statement: "UPDATE exact_keys SET updates = updates + 1 WHERE id = $1 AND part = $2",
      params: ["9007199254740993", "1.00"], expectRows: 1 };
    const preciseTarget = await f.descriptor(precise);
    expect(preciseTarget.primaryKey).toBe('{"id": 9007199254740993, "part": 1.00}');
    await body(await f.execute(precise, await f.approved(precise, preciseTarget)));
    expect(await body(await f.post("/sql", { statement: "SELECT id::text AS id, part::text AS part, updates FROM exact_keys", params: [] })))
      .toMatchObject({ rows: [{ id: "9007199254740993", part: "1.00", updates: 1 }] });
  } finally { await f.pool.close(); }
});

test("a mediated SQL, transaction or Migration write bypasses a User row gate", async () => {
  const f = await fixture();
  try {
    await applyMigration(f.app, f.key, f.runId, f.workspaceId,
      "CREATE INDEX \"items,updates\" ON items (updates); CREATE TABLE other (id int PRIMARY KEY); CREATE TABLE no_key (id int); CREATE TABLE dated (id int PRIMARY KEY, at timestamptz)", 1);
    expect(await body(await f.gate(true, f.headers), 403)).toEqual({ error: "approval_forbidden" });
    expect(await body(await f.gate(true, undefined, "no_key"), 422)).toEqual({ error: "approval_target_unsupported" });
    await body(await f.gate());
    await body(await f.post("/sql", { statement: "INSERT INTO dated (id, at) VALUES (1, '2026-01-01T00:00:00Z')", params: [] }));
    await body(await f.gate(true, undefined, "dated"));
    expect(await body(await f.post("/sql", { statement: "UPDATE dated SET at = $1 WHERE id = 1", params: ["now"] }), 422))
      .toEqual({ error: "approval_target_unsupported" });
    expect(await body(await f.post("/sql", { statement: "UPDATE dated SET at = $1 WHERE id = 1", params: ["2026-02-01T00:00:00Z"] }), 422))
      .toMatchObject({ error: "approval_required" });
    expect(await body(await f.post("/sql", { statement: "INSERT INTO dated (id, at) VALUES (2, '2026-03-01T00:00:00Z')", params: [] })))
      .toMatchObject({ rowCount: "1" });
    expect(await body(await f.post("/transactions", { idempotencyKey: "insert-without-approval", operations: [{ sql: {
      statement: "INSERT INTO dated (id, at) VALUES (3, '2026-03-01T00:00:00Z') ON CONFLICT DO NOTHING", params: [], expectRows: 1,
    } }] }))).toMatchObject({ results: [{ sql: { rowCount: "1" } }] });
    expect(await body(await f.post("/sql", { statement: "INSERT INTO dated (id, at) VALUES (2, '2026-04-01T00:00:00Z') ON CONFLICT DO NOTHING", params: [] })))
      .toMatchObject({ rowCount: "0" });
    const sql = proposal(), target = await f.descriptor(sql);
    expect(target).toMatchObject({ targetKind: "row", primaryKey: '{"id": 1}' });
    expect(await body(await f.execute(sql), 422)).toEqual({ error: "approval_required", target, operationIndex: 0 });
    const unsupported = [
      "UPDATE items SET updates = 4", "UPDATE items SET updates = other.id FROM other WHERE items.id = 1",
      "INSERT INTO items (id, updates) VALUES (1, 99) ON CONFLICT ON CONSTRAINT items_pkey DO UPDATE SET updates = excluded.updates",
      "UPDATE items SET id = 3 WHERE id = 1", "UPDATE items SET updates = length(now()::text) WHERE id = 1",
      "UPDATE items SET updates = length(CURRENT_TIMESTAMP::text) WHERE id = 1",
    ];
    for (const statement of unsupported) expect(await body(await f.post("/sql", { statement, params: [] }), 422))
      .toEqual({ error: "approval_target_unsupported" });
    const migration = async (sql: string) => {
      const input = { name: "gate conflict", sql, expectedRevision: 2, destructive: true };
      const preview = await body<{ sqlHash: string; previewPosition: string }>(await f.post("/migrations/preview", input));
      expect(await body(await f.post("/migrations", { ...input, sqlHash: preview.sqlHash, previewPosition: preview.previewPosition }), 422)).toMatchObject({ error: "approval_gate_conflict" });
    };
    await migration("UPDATE items SET updates = 42 WHERE id = 1");
    await migration("ALTER TABLE items ADD COLUMN extra int");
    await migration('DROP INDEX "items,updates"');
    await migration("CREATE INDEX items_second ON items (updates)");
    await migration("DROP TABLE items");
    expect(await f.rows()).toEqual([{ id: 1, updates: 0 }, { id: 2, updates: 0 }]);
    await body(await f.post("/sql", { statement: "INSERT INTO other (id) VALUES (1)", params: [] }));
    await body(await f.execute(sql, await f.approved(sql)));
    expect((await f.rows())[0]?.updates).toBe(1);
  } finally { await f.pool.close(); }
});

test("concurrent Approval reuse or a failed handoff consumes twice or survives rollback", async () => {
  const f = await fixture();
  try {
    await applyMigration(f.app, f.key, f.runId, f.workspaceId, "CREATE TABLE other (id int PRIMARY KEY)", 1);
    await body(await f.gate());
    const sql = proposal(), approvalId = await f.approved(sql);
    await body(await f.post("/queues/intake/messages", { idempotencyKey: "input", payload: {} }), 201);
    // Receipts bind to the claiming Run, so the later Run of the same Principal claims and hands off itself.
    const runId = await createRun(f.app, f.key, f.workspaceId), headers = { ...f.headers, "x-backplane-run": runId };
    const claim = await body<Claim>(await f.post("/queues/intake/claim", {}, headers));
    const operations: TransactionInput["operations"] = [{ sql: { ...sql, approvalId } },
      { send: { queue: "review", idempotencyKey: "successor", payload: {} } },
      { ack: { deliveryId: claim.deliveryId, receipt: claim.receipt } }];
    expect(await body(await f.post("/transactions", { idempotencyKey: "rollback", operations: [...operations,
      { sql: { statement: "UPDATE other SET id = 5 WHERE id = 99", params: [], expectRows: 1 } },
    ] }, headers), 422)).toEqual({ error: "assertion_failed", operationIndex: 3 });
    expect((await f.rows())[0]?.updates).toBe(0);
    expect(await body(await f.post("/queues/review/claim", {}))).toBeNull();
    expect((await f.audit()).filter((event) => event.kind === "approval.consume")).toHaveLength(0);
    const request = { idempotencyKey: "commit", operations };
    const responses = await Promise.all([f.post("/transactions", request, headers),
      f.post("/transactions", { ...request, idempotencyKey: "competing" }, headers)]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = responses.findIndex((response) => response.status === 200);
    const success = responses[winner], conflict = responses[1 - winner];
    if (!success || !conflict) throw new Error("Concurrent consumption responses missing");
    const committed = await body(success);
    expect(await body(conflict, 409)).toMatchObject({ error: "approval_consumed" });
    expect(await body(await f.post("/transactions", { ...request, idempotencyKey: winner === 0 ? "commit" : "competing" }, headers))).toEqual(committed);
    expect((await f.rows())[0]?.updates).toBe(1);
    const successor = await body<Claim>(await f.post("/queues/review/claim", {}));
    expect(successor).not.toBeNull();
    expect(await body(await f.post("/queues/review/claim", {}))).toBeNull();
    const events = (await f.audit()).filter((event) => event.kind === "approval.consume");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ principal_id: f.principalId, run_id: runId, objects: [approvalId], metadata: { operationIndex: 0, targetKind: "row" } });
    expect(JSON.stringify(events)).not.toContain(sql.statement);
    const remove: Proposal = { statement: "DELETE FROM items WHERE id = $1", params: [2], expectRows: 1 };
    const deletion = await f.approved(remove);
    await body(await f.execute(remove, deletion));
    expect(await body(await f.execute(remove, deletion), 409)).toMatchObject({ error: "approval_consumed" });
    expect(await f.rows()).toEqual([{ id: 1, updates: 1 }]);
  } finally { await f.pool.close(); }
});
