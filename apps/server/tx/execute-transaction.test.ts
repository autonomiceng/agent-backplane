import { expect, test } from "bun:test";
import type { AuditPage } from "../events/read-audit-input.ts";
import { createPool } from "../platform/pool.ts";
import { adminUrl } from "../testing/postgres.ts";
import type { Claim } from "../queue/claim-input.ts";
import type { SqlResponse } from "../sql/execute-sql-input.ts";
import { createRun, issueKey, transactionFixture } from "../testing/session.ts";
import { executeTransaction } from "./execute-transaction.ts";
import { executeTransactionRoute } from "./execute-transaction-route.ts";
import type { TransactionInput, TransactionResponse } from "./execute-transaction-input.ts";

type Fixture = Awaited<ReturnType<typeof transactionFixture>>;
async function body<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const value: unknown = await response.json();
  expect({ status: response.status, ...(response.status === status ? {} : { body: value }) }).toEqual({ status });
  return value as T;
}
function update(id: number, expectRows = 1) {
  return { sql: { statement: "UPDATE items SET updates = updates + 1 WHERE id = $1 RETURNING *", params: [id], expectRows } };
}
function send(idempotencyKey: string, payload: Extract<TransactionInput["operations"][number], { send: unknown }>["send"]["payload"] = { id: 1 }) {
  return { send: { queue: "review", idempotencyKey, payload } };
}
async function claimed(f: Fixture, key = "intake-message", headers = f.headers): Promise<Claim> {
  await body(await f.post("/queues/intake/messages", { idempotencyKey: key, payload: { id: 1 } }), 201);
  return body<Claim>(await f.post("/queues/intake/claim", {}, headers));
}
async function rows(f: Fixture) {
  return (await body<SqlResponse>(await f.post("/sql", {
    statement: "SELECT * FROM items ORDER BY id", params: [],
  }))).rows;
}
async function deliveries(f: Fixture) {
  return f.pool<{ id: string; state: string }[]>`SELECT id, state FROM queue.delivery_envelopes
    WHERE workspace_id = ${f.workspaceId} AND queue = 'intake' ORDER BY id`;
}
async function reviewMessages(f: Fixture) {
  return f.pool<{ id: string; producer_principal_id: string; producer_run_id: string }[]>`
    SELECT id, producer_principal_id, producer_run_id FROM queue.messages
    WHERE workspace_id = ${f.workspaceId} AND queue = 'review' ORDER BY id`;
}
async function receipts(f: Fixture) {
  return f.pool<{ response: TransactionResponse; position: string }[]>`SELECT response, position::text FROM control.transaction_receipts
    WHERE workspace_id = ${f.workspaceId} ORDER BY position`;
}

test("crash after ack partially commits the row, successor, Delivery or transaction receipt", async () => {
  const f = await transactionFixture();
  try {
    const claim = await claimed(f);
    const before = await rows(f);
    const input = { idempotencyKey: "crash", operations: [update(1), send("successor"),
      { ack: { deliveryId: claim.deliveryId, receipt: claim.receipt } }] };
    const faultApp = executeTransactionRoute(f.pool, (pool, context, request) => executeTransaction(pool, context, request, {
      afterOperation(index) { if (index === 2) throw new Error("injected_crash"); },
    }));
    const response = await faultApp.handle(new Request(`${f.baseUrl}/transactions`, {
      method: "POST", headers: f.headers, body: JSON.stringify(input),
    }));
    expect(await body<{ error: string; operationIndex?: number }>(response, 503)).toEqual({ error: "transaction_unavailable", operationIndex: 2 });
    expect(await rows(f)).toEqual(before);
    expect(await deliveries(f)).toEqual([{ id: claim.deliveryId, state: "leased" }]);
    expect(await reviewMessages(f)).toEqual([]);
    expect(await receipts(f)).toEqual([]);
    expect(await f.pool`SELECT position FROM audit.events WHERE workspace_id = ${f.workspaceId}
      AND kind IN ('queue.ack', 'transaction.committed')`).toHaveLength(0);
    expect(await f.pool<{ reason: string; objects: string[] }[]>`SELECT reason, objects FROM audit.rejections WHERE workspace_id = ${f.workspaceId}
      AND kind = 'transaction.committed'`).toEqual([{ reason: "transaction_unavailable", objects: ["operation.2"] }]);
    await body<TransactionResponse>(await f.post("/transactions", input));
    expect((await rows(f))[0]).toMatchObject({ updates: 1 });
    expect(await deliveries(f)).toEqual([{ id: claim.deliveryId, state: "succeeded" }]);
    expect(await reviewMessages(f)).toHaveLength(1);
    expect(await receipts(f)).toHaveLength(1);
  } finally { await f.pool.close(); }
});

test("lost commit response repeats the dogfood handoff or attributes consumer changes to the producer Run", async () => {
  const f = await transactionFixture();
  try {
    const principal = await body<{ id: string }>(await f.post("/principals", { name: "Consumer" }, {
      cookie: f.cookie, origin: "http://localhost", "content-type": "application/json",
    }), 201);
    const key = await issueKey(f.app, f.cookie, f.workspaceId, principal.id);
    const runId = await createRun(f.app, key, f.workspaceId);
    const headers = { authorization: `Bearer ${key}`, "x-backplane-run": runId, "content-type": "application/json" };
    const claim = await claimed(f, "producer-send", headers);
    const payload = claim.payload as { id: number };
    const input = { idempotencyKey: "dogfood", operations: [update(payload.id), send("review-send", { id: payload.id }),
      { ack: { deliveryId: claim.deliveryId, receipt: claim.receipt } }] };
    const firstResponse = await f.post("/transactions", input, headers);
    expect(firstResponse.headers.get("cache-control")).toBe("no-store");
    const first = await body<TransactionResponse>(firstResponse);
    expect(first).toMatchObject({ committed: true, results: [
      { sql: { rowCount: "1", truncated: false } }, { send: { inserted: true } },
      { ack: { deliveryId: claim.deliveryId, state: "succeeded" } },
    ] });
    const committedEvents = await f.pool`SELECT position FROM audit.events WHERE workspace_id = ${f.workspaceId} ORDER BY position`;
    const replayResponse = await f.post("/transactions", input, headers);
    expect(replayResponse.headers.get("cache-control")).toBe("no-store");
    expect(await body<TransactionResponse>(replayResponse)).toEqual(first);
    expect(await f.pool`SELECT position FROM audit.events WHERE workspace_id = ${f.workspaceId} ORDER BY position`).toEqual(committedEvents);
    expect((await rows(f))[0]).toEqual({ id: 1, updates: 1, principal_id: principal.id, run_id: runId });
    const review = await reviewMessages(f);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ producer_principal_id: principal.id, producer_run_id: runId });
    expect(await f.pool<{ producer_principal_id: string; producer_run_id: string }[]>`SELECT producer_principal_id, producer_run_id FROM queue.messages WHERE id = ${claim.messageId}`)
      .toEqual([{ producer_principal_id: f.principalId, producer_run_id: f.runId }]);
    expect(await deliveries(f)).toEqual([{ id: claim.deliveryId, state: "succeeded" }]);
    const page = await body<AuditPage>(await f.app.handle(new Request(`${f.baseUrl}/audit?limit=500`, { headers })));
    const handoff = page.events.filter((event) =>
      (event.kind === "queue.send" && event.run_id === f.runId)
      || (event.run_id === runId && event.kind !== "runs.created" && event.kind !== "queue.ready"));
    expect(handoff.map((event) => [event.kind, event.run_id])).toEqual([
      ["queue.send", f.runId], ["queue.claim", runId], ["sql.execute", runId],
      ["queue.send", runId], ["queue.ack", runId], ["transaction.committed", runId],
    ]);
    for (let index = 1; index < handoff.length; index++) {
      expect(BigInt(handoff[index]!.position)).toBeGreaterThan(BigInt(handoff[index - 1]!.position));
    }
    expect(handoff.at(-1)).toMatchObject({ position: first.position, objects: ["sql", "send", "ack"], row_count: null,
      metadata: { operations: 3, idempotency_key_present: true } });
    expect(await receipts(f)).toEqual([{ position: first.position, response: first }]);
    expect(JSON.stringify(await receipts(f))).not.toContain(claim.receipt);
    expect(first.results[0]).toEqual({ sql: { rowCount: "1", truncated: false } });
    // Replay belongs to the Principal and remains readable using a later valid Run.
    const laterRun = await createRun(f.app, key, f.workspaceId);
    expect(await body<TransactionResponse>(await f.post("/transactions", input, { ...headers, "x-backplane-run": laterRun }))).toEqual(first);
  } finally { await f.pool.close(); }
});

test("changed payload or expectRows reuses a committed key while reordered object keys fail to replay", async () => {
  const f = await transactionFixture();
  try {
    const input = { idempotencyKey: "hash", operations: [update(1), send("hashed-send", { id: 1, nested: { a: 2, b: 3 } })] };
    const first = await body<TransactionResponse>(await f.post("/transactions", input));
    const events = await f.pool`SELECT position FROM audit.events WHERE workspace_id = ${f.workspaceId} ORDER BY position`;
    expect(await body<{ error: string; operationIndex?: number }>(await f.post("/transactions", { ...input, operations: [update(1), send("hashed-send", { id: 2 })] }), 409))
      .toEqual({ error: "idempotency_conflict" });
    expect(await body<{ error: string; operationIndex?: number }>(await f.post("/transactions", { ...input, operations: [update(1, 0), input.operations[1]] }), 409))
      .toEqual({ error: "idempotency_conflict" });
    expect(await body<TransactionResponse>(await f.post("/transactions", { operations: [
      { sql: { expectRows: 1, params: [1], statement: update(1).sql.statement } },
      { send: { payload: { nested: { b: 3, a: 2 }, id: 1 }, idempotencyKey: "hashed-send", queue: "review" } },
    ], idempotencyKey: "hash" }))).toEqual(first);
    expect(await f.pool`SELECT position FROM audit.events WHERE workspace_id = ${f.workspaceId} ORDER BY position`).toEqual(events);
    expect((await rows(f))[0]).toMatchObject({ updates: 1 });
    expect(await reviewMessages(f)).toHaveLength(1);
    expect(await receipts(f)).toEqual([{ position: first.position, response: first }]);
  } finally { await f.pool.close(); }
});

test("zero-row assertion commits a preceding send or reports the wrong operation index", async () => {
  const f = await transactionFixture();
  try {
    expect(await body<{ error: string; operationIndex?: number }>(await f.post("/transactions", { idempotencyKey: "missing", operations: [update(999)] }), 422))
      .toEqual({ error: "assertion_failed", operationIndex: 0 });
    expect(await body<{ error: string; operationIndex?: number }>(await f.post("/transactions", {
      idempotencyKey: "missing-after-send", operations: [send("rolled-back"), update(999)],
    }), 422)).toEqual({ error: "assertion_failed", operationIndex: 1 });
    expect(await reviewMessages(f)).toEqual([]);
    expect(await receipts(f)).toEqual([]);
    expect((await rows(f)).map((row) => row.updates)).toEqual([0, 0]);
    expect(await f.pool`SELECT position FROM audit.events WHERE workspace_id = ${f.workspaceId}
      AND kind IN ('queue.send', 'queue.ready', 'transaction.committed')`).toHaveLength(0);
    expect(await f.pool<{ reason: string; objects: string[] }[]>`SELECT reason, objects FROM audit.rejections WHERE workspace_id = ${f.workspaceId}
      AND kind = 'transaction.committed' ORDER BY id`).toEqual([
      { reason: "assertion_failed", objects: ["operation.0"] }, { reason: "assertion_failed", objects: ["operation.1"] },
    ]);
  } finally { await f.pool.close(); }
});

test("overlapping handoffs deadlock, duplicate Delivery verbs partially commit or concurrent same-key retries execute twice", async () => {
  const f = await transactionFixture(2);
  const admin = createPool(adminUrl(f.url));
  try {
    const a = await claimed(f, "a");
    const b = await claimed(f, "b");
    const ackA = { ack: { deliveryId: a.deliveryId, receipt: a.receipt } };
    const ackB = { ack: { deliveryId: b.deliveryId, receipt: b.receipt } };
    expect(await body<{ error: string; operationIndex?: number }>(await f.post("/transactions", { idempotencyKey: "duplicate", operations: [update(1), ackA,
      { hold: { deliveryId: a.deliveryId.toUpperCase(), receipt: a.receipt } }] }), 422))
      .toEqual({ error: "invalid_input", operationIndex: 2 });
    expect((await rows(f)).map((row) => row.updates)).toEqual([0, 0]);
    const paused = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const pausedApp = executeTransactionRoute(f.pool, (pool, context, input) => executeTransaction(pool, context, input, {
      async afterOperation(index, tx) {
        if (index !== 0) return;
        const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        if (!backend) throw new Error("backend_missing");
        paused.resolve(backend.pid);
        await release.promise;
      },
    }));
    const first = pausedApp.handle(new Request(`${f.baseUrl}/transactions`, {
      method: "POST", headers: f.headers, body: JSON.stringify({
        idempotencyKey: "opposite-a", operations: [update(1), update(2), ackA],
      }),
    }));
    let second: Promise<Response> | undefined;
    try {
      const firstPid = await Promise.race([paused.promise, first.then(() => { throw new Error("request_finished_before_pause"); })]);
      second = f.post("/transactions", { idempotencyKey: "opposite-b", operations: [update(2), update(1), ackB] });
      const deadline = Date.now() + 2000;
      let waitingPid: number | undefined;
      while (Date.now() < deadline) {
        const [waiter] = await admin<{ pid: number }[]>`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> ${firstPid}
            AND wait_event_type = 'Lock' AND query LIKE '%bind_context%'
            AND ${firstPid} = ANY(pg_blocking_pids(pid)) LIMIT 1`;
        if (waiter) { waitingPid = waiter.pid; break; }
        await Bun.sleep(10);
      }
      expect(waitingPid).toBeDefined();
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
    if (!second) throw new Error("second_request_missing");
    expect((await body<TransactionResponse>(await first)).committed).toBe(true);
    expect((await body<TransactionResponse>(await second)).committed).toBe(true);
    expect((await rows(f)).map((row) => row.updates)).toEqual([2, 2]);
    expect((await deliveries(f)).map((delivery) => delivery.state)).toEqual(["succeeded", "succeeded"]);
    expect(await receipts(f)).toHaveLength(2);
    expect(await f.pool`SELECT position FROM audit.events WHERE workspace_id = ${f.workspaceId} AND kind = 'queue.ack'`).toHaveLength(2);
    expect(await f.pool`SELECT position FROM audit.events WHERE workspace_id = ${f.workspaceId} AND kind = 'transaction.committed'`).toHaveLength(2);
    const input = { idempotencyKey: "concurrent-replay", operations: [update(1)] };
    const [original, replay] = await Promise.all([
      f.post("/transactions", input), f.post("/transactions", input),
    ]);
    const committed = await body<TransactionResponse>(original);
    expect(await body<TransactionResponse>(replay)).toEqual(committed);
    expect((await rows(f)).map((row) => row.updates)).toEqual([3, 2]);
    expect(await f.pool<{ response: TransactionResponse; position: string }[]>`
      SELECT response, position::text FROM control.transaction_receipts
      WHERE workspace_id = ${f.workspaceId} AND idempotency_key = ${input.idempotencyKey}`)
      .toEqual([{ response: committed, position: committed.position }]);
    expect(await receipts(f)).toHaveLength(3);
    expect(await f.pool`SELECT position FROM audit.events WHERE workspace_id = ${f.workspaceId}
      AND kind = 'transaction.committed' AND position = ${committed.position}::bigint`).toHaveLength(1);
    expect(await f.pool`SELECT position FROM audit.events WHERE workspace_id = ${f.workspaceId}
      AND kind = 'transaction.committed'`).toHaveLength(3);
  } finally { await admin.close(); await f.pool.close(); }
});

test("bounds, forbidden operations or transaction timeout commit effects, or SQL leaks its role into send and hold", async () => {
  const f = await transactionFixture();
  try {
    const claim = await claimed(f);
    const hold = { hold: { deliveryId: claim.deliveryId, receipt: claim.receipt } };
    const oversized = `SELECT 1 /*${"x".repeat(33000)}*/`;
    const invalid: unknown[] = [
      { operations: Array.from({ length: 17 }, () => update(1)) },
      { operations: [send("prefix"), { sql: { statement: "CREATE TABLE escaped (id int)", params: [] } }] },
      { operations: [send("prefix"), { sql: { statement: "SET ROLE bp_server", params: [] } }] },
      { operations: [send("prefix"), { sql: { statement: "SELECT * FROM control.principals", params: [] } }] },
      { operations: [send("prefix"), { claim: { queue: "intake" } }] },
      { operations: [update(1), send("too-big", "x".repeat(300 * 1024))] },
      { operations: [send("prefix"), { sql: { statement: oversized, params: [] } }, { sql: { statement: oversized, params: [] } }] },
      { operations: [send("prefix"), { ...update(1), ...hold }] },
      { operations: [send("prefix"), { sql: { statement: "SELECT 1", params: [], expectRows: 1 } }] },
      { operations: [send("prefix"), { sql: { ...update(1).sql, extra: true } }] },
      { operations: [send("prefix"), { send: { queue: "review", idempotencyKey: "no-payload" } }] },
      { operations: [update(1)], extra: true },
      { operations: [send("prefix"), { sql: { statement: "COMMIT", params: [] } }] },
      { operations: [send("prefix"), { sql: { statement: "SELECT $1::text", params: ["x".repeat(1048576)] } }] },
      { operations: [send("prefix"), send("jsonb-limit", Array.from({ length: 90000 }, () => 0))] },
    ];
    for (const [index, input] of invalid.entries()) {
      const response = await f.post("/transactions", { idempotencyKey: `invalid-${index}`, ...input as object });
      expect(response.status, `invalid case ${index}: ${await response.clone().text()}`).toBe(422);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const malformed = await f.app.handle(new Request(`${f.baseUrl}/transactions`, {
      method: "POST", headers: f.headers, body: "{",
    }));
    expect(await body<{ error: string; operationIndex?: number }>(malformed, 400)).toEqual({ error: "invalid_input" });
    // transaction_timeout is armed at transaction start; the installed value is asserted below, the fired path is not provoked.
    const connectionStates: { role: string; path: string; timeout: string }[] = [];
    const checkedApp = executeTransactionRoute(f.pool, (pool, context, input) => executeTransaction(pool, context, input, {
      async afterOperation(_index, tx) {
        connectionStates.push(...await tx<{ role: string; path: string; timeout: string }[]>`
          SELECT current_user AS role, current_setting('search_path') AS path,
            current_setting('transaction_timeout') AS timeout`);
      },
    }));
    const valid = await body<TransactionResponse>(await checkedApp.handle(new Request(`${f.baseUrl}/transactions`, {
      method: "POST", headers: f.headers, body: JSON.stringify({
        idempotencyKey: "hold", operations: [update(1), send("held-successor"), hold],
      }),
    })));
    expect(connectionStates).toEqual(Array.from({ length: 3 }, () => ({ role: "bp_server", path: "pg_catalog", timeout: "10s" })));
    expect(valid.results).toHaveLength(3);
    expect(valid.results[2]).toEqual({ hold: { deliveryId: claim.deliveryId, state: "held" } });
    expect((await rows(f))[0]).toMatchObject({ updates: 1 });
    expect(await deliveries(f)).toEqual([{ id: claim.deliveryId, state: "held" }]);
    expect(await reviewMessages(f)).toHaveLength(1);
    expect(await receipts(f)).toHaveLength(1);
    expect(await f.pool<{ role: string }[]>`SELECT current_user AS role`).toEqual([{ role: "bp_server" }]);
  } finally { await f.pool.close(); }
});
