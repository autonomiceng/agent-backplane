import { expect, test } from "bun:test";
import { loadMigrations, migrate } from "../../../db/migrations.ts";
import { sqlMigrationRunner } from "../../../db/sql-migration-runner.ts";
import { createPool } from "../platform/pool.ts";
import { adminUrl, emptyDatabase, migratedDatabase } from "../testing/postgres.ts";
import { advanceDeliveryClock, applyMigration, createRun, issueKey, recoveryFixture } from "../testing/session.ts";
import type { AuditPage } from "../events/read-audit-input.ts";
import type { Claim } from "../queue/claim-input.ts";
import type { Message } from "../queue/send-message-input.ts";
import type { reconcileResponse } from "../queue/reconcile-input.ts";
import { retentionError } from "./retention-error.ts";
import type { purgeResponse } from "./purge-payloads-input.ts";

const migrationsDir = new URL("../../../db/migrations", import.meta.url).pathname;
async function fixture(legacy = false) {
  let url = await migratedDatabase();
  if (legacy) {
    const oldUrl = await emptyDatabase();
    const owner = createPool(oldUrl);
    try {
      for (const file of ["001-pgmq.sql", "002-pgmq-version.sql"]) {
        await owner.unsafe(await Bun.file(new URL(`../../../infra/init/core/${file}`, import.meta.url)).text());
      }
      await migrate(sqlMigrationRunner(owner), (await loadMigrations(migrationsDir)).filter((m) => m.version < 20));
    } finally { await owner.close(); }
    const runtime = new URL(url); runtime.pathname = new URL(oldUrl).pathname; url = runtime.toString();
  }
  const pool = createPool(url), admin = createPool(adminUrl(url));
  try {
    const f = await recoveryFixture(pool);
    const call = (path: string, body?: unknown, headers: Record<string, string> = f.userHeaders, method = body === undefined ? "GET" : "POST") =>
      f.app.handle(new Request(`${f.baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const policy = async (seconds: number) => { expect((await call("/retention", { seconds }, f.userHeaders, "PUT")).status).toBe(200); };
    const audit = async () => await (await call("/audit?limit=500")).json() as AuditPage;
    const send = async (key: string, payload: unknown = { secret: key }) => {
      const response = await f.send(key, payload); expect(response.status).toBe(201);
      return await response.json() as Message;
    };
    const claim = async () => { const response = await f.claim(); expect(response.status).toBe(200); return await response.json() as Claim; };
    const begin = async (c: Claim) => {
      expect((await call(`/deliveries/${c.deliveryId}/begin-effect`, { receipt: c.receipt, action: c.messageId, destination: "private" }, f.headers)).status).toBe(200);
    };
    const decide = (c: Claim, outcome: string) => call("/reconciliations", { deliveryId: c.deliveryId, outcome, evidence: "private evidence" });
    const waitExpired = () => admin`SELECT pg_sleep(greatest(0,extract(epoch FROM max(deadline)-clock_timestamp()))+0.02) FROM (
      SELECT expires_at AS deadline FROM queue.messages WHERE workspace_id=${f.workspaceId} AND expires_at<clock_timestamp()+interval '10 seconds'
      UNION ALL SELECT expires_at FROM control.workspace_migrations WHERE workspace_id=${f.workspaceId} AND expires_at<clock_timestamp()+interval '10 seconds'
      UNION ALL SELECT expires_at FROM control.reconciliations WHERE workspace_id=${f.workspaceId} AND expires_at<clock_timestamp()+interval '10 seconds') deadlines`;
    const payload = (position: string, headers: Record<string, string> = f.userHeaders) => call(`/audit/${position}/payload`, undefined, headers);
    return { ...f, pool, admin, call, policy, audit, send, claim, begin, decide, waitExpired, payload,
      close: async () => { await pool.close(); await admin.close(); } };
  } catch (error) { await pool.close(); await admin.close(); throw error; }
}
async function denied(response: Response, status: number, error: string) {
  expect(response.status).toBe(status); expect(await response.json()).toEqual({ error });
}
function event(page: AuditPage, kind: string, object?: string) {
  const found = page.events.find((e) => e.kind === kind && (object === undefined || e.objects.includes(object)));
  if (!found) throw new Error(`missing ${kind}`);
  return found;
}

test("expired captures leak through reads or regain a deadline through resend and redispatch", async () => {
  const f = await fixture();
  try {
    expect(await (await f.call("/retention")).json()).toEqual({ seconds: 2592000 });
    await denied(await f.call("/retention", undefined, f.headers), 403, "retention_forbidden");
    await denied(await f.call("/retention", { seconds: 1 }, { ...f.userHeaders, origin: "https://foreign.example" }, "PUT"), 403, "origin_forbidden");
    await denied(await f.call("/retention", { seconds: 0 }, f.userHeaders, "PUT"), 422, "invalid_input");
    await f.policy(1);
    const nullMessage = await f.send("null", null);
    const nullEvent = event(await f.audit(), "queue.send", nullMessage.id);
    const nullPayload = await f.payload(nullEvent.position, f.headers);
    expect(nullPayload.status).toBe(200); expect(nullPayload.headers.get("cache-control")).toBe("no-store");
    expect(await nullPayload.json()).toMatchObject({ payloads: [{ kind: "message", value: null }] });
    expect(await (await f.call(`/queues/${f.queue}/messages/${nullMessage.id}`, undefined, f.headers)).json()).toMatchObject({ payload: null });
    const nullClaim = await f.claim(); expect(nullClaim.payload).toBeNull();
    expect((await f.receipt(nullClaim.deliveryId, nullClaim.receipt, "ack")).status).toBe(200);
    const sql = "CREATE TABLE retained (id integer PRIMARY KEY)";
    await applyMigration(f.app, f.key, f.runId, f.workspaceId, sql);
    const migrationEvent = event(await f.audit(), "migration.applied");
    expect(await (await f.payload(migrationEvent.position)).json()).toMatchObject({ payloads: [{ kind: "migration", value: sql }] });
    await f.send("ambiguous"); const ambiguous = await f.claim(); await f.begin(ambiguous);
    expect((await f.receipt(ambiguous.deliveryId, ambiguous.receipt, "nack")).status).toBe(200);
    const decisionResponse = await f.decide(ambiguous, "unknown"); expect(decisionResponse.status).toBe(200);
    const decision = await decisionResponse.json() as typeof reconcileResponse.static;
    expect(await (await f.payload(decision.decisionPosition)).json()).toMatchObject({ payloads: [{ kind: "reconciliation", value: "private evidence" }] });
    await f.send("held"); const held = await f.claim();
    expect((await f.receipt(held.deliveryId, held.receipt, "hold")).status).toBe(200);
    await f.send("scheduled"); const scheduled = await f.claim();
    expect((await f.receipt(scheduled.deliveryId, scheduled.receipt, "nack")).status).toBe(200);
    const ready = await f.send("ready");
    const [before] = await f.admin<{ expires_at: Date }[]>`SELECT expires_at FROM queue.messages WHERE id=${ready.id}`;
    if (!before) throw new Error("deadline missing");
    await f.policy(3600);
    expect((await f.send("unused-long-lived")).id).toBeString();
    const resend = await f.app.handle(new Request(f.messagesUrl, { method: "POST", headers: f.headers,
      body: JSON.stringify({ idempotencyKey: "ready", payload: { secret: "ready" } }) }));
    expect(resend.status).toBe(200); expect(await resend.json()).toMatchObject({ id: ready.id });
    expect(await f.admin<{ expires_at: Date }[]>`SELECT expires_at FROM queue.messages WHERE id=${ready.id}`).toEqual([before]);
    await f.waitExpired();
    await denied(await f.payload(nullEvent.position), 410, "payload_expired");
    await denied(await f.payload(migrationEvent.position), 410, "payload_expired");
    await denied(await f.payload(decision.decisionPosition), 410, "payload_expired");
    const messageGone = await f.call(`/queues/${f.queue}/messages/${nullMessage.id}`, undefined, f.headers);
    expect(messageGone.headers.get("cache-control")).toBe("no-store"); await denied(messageGone, 410, "payload_expired");
    await denied(await f.call(`/deliveries/${held.deliveryId}/release`, {}), 410, "payload_expired");
    await denied(await f.decide(ambiguous, "not_applied"), 410, "payload_expired");
    expect(await (await f.decide(ambiguous, "unknown")).json()).toEqual(decision);
    expect((await f.decide(ambiguous, "applied")).status).toBe(200);
    const claimingRun = await createRun(f.app, f.key, f.workspaceId);
    const claimResponse = await f.call(`/queues/${f.queue}/claim`, {}, { ...f.headers, "x-backplane-run": claimingRun });
    expect(claimResponse.status).toBe(200); expect(await claimResponse.json()).toMatchObject({ payload: { secret: "unused-long-lived" } });
    const expiredDeliveries = await f.admin<{ id: string; message_id: string; state: string; failure_code: string }[]>`
      SELECT id,message_id,state,failure_code FROM queue.deliveries WHERE message_id IN (${ready.id},${scheduled.messageId}) AND current`;
    expect(expiredDeliveries).toHaveLength(2);
    for (const delivery of expiredDeliveries) {
      expect(delivery).toMatchObject({ state: "dead-lettered", failure_code: "payload_expired" });
      expect(event(await f.audit(), "queue.dead-letter", delivery.id)).toMatchObject({ run_id: claimingRun, principal_id: f.principalId });
    }
    await denied(await f.replay(expiredDeliveries[0]!.id), 410, "payload_expired");
    const foreignResponse = await f.app.handle(new Request("http://localhost/api/v1/workspaces", { method: "POST", headers: f.userHeaders, body: '{"name":"Foreign"}' }));
    expect(foreignResponse.status).toBe(201); const foreign = await foreignResponse.json() as { id: string };
    const principalResponse = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${foreign.id}/principals`, {
      method: "POST", headers: f.userHeaders, body: '{"name":"Foreign Principal"}',
    }));
    const foreignPrincipal = await principalResponse.json() as { id: string };
    const foreignKey = await issueKey(f.app, f.cookie, foreign.id, foreignPrincipal.id);
    await denied(await f.payload(nullEvent.position, { authorization: `Bearer ${foreignKey}` }), 403, "workspace_forbidden");
    await denied(await f.payload(nullEvent.position, { ...f.userHeaders, authorization: "bad" }), 401, "unauthorized");
    const foreignRead = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${foreign.id}/audit/${nullEvent.position}/payload`, { headers: f.userHeaders }));
    expect(foreignRead.status).toBe(404);
    await denied(await f.payload("9223372036854775808"), 400, "invalid_query");
    await denied(await f.payload("9223372036854775807"), 404, "audit_event_not_found");
    await denied(await f.payload(event(await f.audit(), "queue.created").position), 404, "payload_not_captured");
    // Source ledgers have no deletion API; classify a missing/mismatched source without admin edits.
    expect(retentionError(new Error("payload_read_failed"))).toEqual({ ok: false, status: 503, error: "payload_read_failed" });
  } finally { await f.close(); }
}, 30000);

test("purge leaves original or successor bytes behind or breaks Receipts and permanent audit cursors", async () => {
  const f = await fixture(true);
  try {
    const legacyMessage = await f.send("legacy"); const legacyClaim = await f.claim(); await f.begin(legacyClaim);
    expect((await f.receipt(legacyClaim.deliveryId, legacyClaim.receipt, "nack")).status).toBe(200);
    const legacyDecision = await (await f.decide(legacyClaim, "unknown")).json() as typeof reconcileResponse.static;
    await migrate(sqlMigrationRunner(f.admin), (await loadMigrations(migrationsDir)).filter(m => m.version <= 30));
    expect(await f.admin<{ valid: boolean }[]>`SELECT expires_at=created_at+interval '30 days' AS valid FROM queue.messages WHERE id=${legacyMessage.id}`).toEqual([{ valid: true }]);
    expect(await f.admin<{ valid: boolean }[]>`SELECT expires_at=created_at+interval '30 days' AS valid FROM control.reconciliations WHERE id=${legacyDecision.id}`).toEqual([{ valid: true }]);
    await f.policy(1);
    const sql = "CREATE TABLE purge_capture (id integer PRIMARY KEY)";
    await applyMigration(f.app, f.key, f.runId, f.workspaceId, sql);
    await f.send("reconciled"); const reconciled = await f.claim(); await f.begin(reconciled);
    expect((await f.receipt(reconciled.deliveryId, reconciled.receipt, "nack")).status).toBe(200);
    const decisionResponse = await f.decide(reconciled, "not_applied"); expect(decisionResponse.status).toBe(200);
    const decision = await decisionResponse.json() as typeof reconcileResponse.static;
    const successor = await f.claim(); expect(successor.deliveryId).toBe(decision.successorDeliveryId!);
    expect((await f.receipt(successor.deliveryId, successor.receipt, "ack")).status).toBe(200);
    await f.send("released"); const held = await f.claim();
    expect((await f.receipt(held.deliveryId, held.receipt, "hold")).status).toBe(200);
    expect((await f.call(`/deliveries/${held.deliveryId}/release`, {})).status).toBe(201);
    const leased = await f.claim();
    await f.send("begun"); const begun = await f.claim(); await f.begin(begun);
    await f.send("scheduled"); const scheduled = await f.claim();
    expect((await f.receipt(scheduled.deliveryId, scheduled.receipt, "nack")).status).toBe(200);
    const ready = await f.send("ready");
    const nullMessage = await f.send("real-null", null);
    await f.policy(3600);
    const control = await f.send("control");
    await applyMigration(f.app, f.key, f.runId, f.workspaceId, "CREATE TABLE live_capture (id integer PRIMARY KEY)", 1);
    await f.waitExpired();
    const envelopes = (await f.audit()).events;
    const [cursor] = await f.pool<{ last_position: string; retention_floor: string; generation: string }[]>`
      SELECT last_position::text,retention_floor::text,generation FROM audit.cursor WHERE workspace_id=${f.workspaceId}`;
    if (!cursor) throw new Error("cursor missing");
    const [physical] = await f.pool<{ pgmq_queue: string }[]>`SELECT pgmq_queue FROM queue.queues WHERE workspace_id=${f.workspaceId} AND name=${f.queue}`;
    if (!physical) throw new Error("queue missing");
    const inspect = (prefix: string) => f.admin<{ msg_id: string; message: string }[]>`
      SELECT msg_id::text,message::text FROM ${f.admin(`pgmq.${prefix}_${physical.pgmq_queue}`)} ORDER BY msg_id`;
    const initialQueue = await inspect("q"), initialArchive = await inspect("a");
    expect(initialArchive.length).toBeGreaterThanOrEqual(4);
    const counts = { queueBodies: 0, archiveRows: 0, migrationSql: 0, reconciliationEvidence: 0, blobs: 0 };
    let batches = 0;
    while (true) {
      const response = await f.call("/retention/purge", { limit: 1 }); expect(response.status).toBe(200);
      const result = await response.json() as typeof purgeResponse.static;
      const touched = Object.values(result.counts).reduce((sum, n) => sum + n, 0); expect(touched).toBeLessThanOrEqual(1);
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] += result.counts[key];
      batches++; expect(batches).toBeLessThan(30);
      if (!result.hasMore) break;
      expect(touched).toBe(1);
    }
    expect(counts).toEqual({ queueBodies: initialQueue.length - 2, archiveRows: initialArchive.length - 1, migrationSql: 1, reconciliationEvidence: 1, blobs: 0 });
    const scrubbed = await inspect("q"); expect(scrubbed).toHaveLength(initialQueue.length);
    expect(scrubbed.filter((row) => row.message !== "null")).toHaveLength(1);
    expect(scrubbed.find((row) => row.message !== "null")?.message).toContain("control");
    expect(await inspect("a")).toHaveLength(1);
    expect(await f.admin<{ sql: string | null }[]>`SELECT sql FROM control.workspace_migrations WHERE workspace_id=${f.workspaceId} ORDER BY revision`)
      .toEqual([{ sql: null }, { sql: "CREATE TABLE live_capture (id integer PRIMARY KEY)" }]);
    expect(await f.admin<{ evidence: string | null }[]>`SELECT evidence FROM control.reconciliations WHERE id=${decision.id}`).toEqual([{ evidence: null }]);
    expect(await f.admin<{ evidence: string }[]>`SELECT evidence FROM control.reconciliations WHERE id=${legacyDecision.id}`).toEqual([{ evidence: "private evidence" }]);
    expect((await f.payload(event({ events: envelopes, nextAfter: "0" }, "queue.send", control.id).position)).status).toBe(200);
    expect(await (await f.decide(reconciled, "not_applied")).json()).toEqual(decision);
    expect((await f.receipt(leased.deliveryId, leased.receipt, "renew")).status).toBe(200);
    expect((await f.receipt(leased.deliveryId, leased.receipt, "ack")).status).toBe(200);
    expect((await f.receipt(begun.deliveryId, begun.receipt, "renew")).status).toBe(200);
    await advanceDeliveryClock(f.admin, f, begun.deliveryId, "leased");
    const claim = await f.claim(); expect(claim.messageId).toBe(control.id);
    expect(await f.admin<{ state: string }[]>`SELECT state FROM queue.deliveries WHERE id=${begun.deliveryId}`).toEqual([{ state: "ambiguous" }]);
    expect(await f.admin<{ state: string }[]>`SELECT state FROM queue.deliveries WHERE message_id IN (${ready.id},${nullMessage.id},${scheduled.messageId}) AND current`)
      .toEqual([{ state: "dead-lettered" }, { state: "dead-lettered" }, { state: "dead-lettered" }]);
    const finalPurge = await f.call("/retention/purge", { limit: 100 }); expect(finalPurge.status).toBe(200);
    expect(await finalPurge.json()).toMatchObject({ counts: { archiveRows: 5 }, hasMore: false });
    expect(await inspect("a")).toHaveLength(1);
    const after = (await f.audit()).events;
    expect(after.slice(0, envelopes.length)).toEqual(envelopes);
    expect(await f.pool<{ retention_floor: string; generation: string }[]>`SELECT retention_floor::text,generation FROM audit.cursor WHERE workspace_id=${f.workspaceId}`)
      .toEqual([{ retention_floor: cursor.retention_floor, generation: cursor.generation }]);
    const [user] = await f.pool<{ id: string }[]>`SELECT id FROM control."user" WHERE email='credentials@example.com'`;
    for (const purged of after.filter((e) => e.kind === "retention.purged")) {
      expect(purged).toMatchObject({ objects: [], user_id: user?.id, principal_id: null, run_id: null });
      expect(Object.keys(purged.metadata).sort()).toEqual(Object.keys(counts).sort());
      expect(Object.values(purged.metadata).every((n) => typeof n === "number")).toBe(true);
    }
    const controller = new AbortController();
    const stream = await f.app.handle(new Request(`${f.baseUrl}/events`, { signal: controller.signal,
      headers: { ...f.userHeaders, "Last-Event-ID": `v1:${f.workspaceId}:${cursor.generation}:${cursor.last_position}` } }));
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader(); let frames = "";
    try {
      while (!frames.includes("retention.purged")) {
        const part = await reader.read(); expect(part.done).toBe(false);
        frames += new TextDecoder().decode(part.value);
      }
      expect(frames).toContain(`v1:${f.workspaceId}:${cursor.generation}:`);
      expect(frames).not.toContain("private evidence");
    } finally { controller.abort(); await reader.cancel(); }
  } finally { await f.close(); }
}, 30000);
