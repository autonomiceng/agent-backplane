import { expect, test } from "bun:test";
import type { App } from "../app.ts";
import { createPool, type Pool } from "../platform/pool.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { createRun, issueKey, queueFixture } from "../testing/session.ts";
import type { Claim } from "./claim-input.ts";
import type { Nack } from "./nack-input.ts";

type Fixture = Awaited<ReturnType<typeof queueFixture>>;

async function claim(fixture: Fixture) {
  const { app, workspaceId, queue, headers } = fixture;
  const response = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/queues/${queue}/claim`, {
    method: "POST", headers, body: "{}",
  }));
  expect(response.status).toBe(200);
  return await response.json() as Claim | null;
}

async function sendAndClaim(fixture: Fixture, key = "message") {
  const response = await fixture.app.handle(new Request(fixture.messagesUrl, {
    method: "POST", headers: fixture.headers, body: JSON.stringify({ idempotencyKey: key, payload: { task: key } }),
  }));
  expect(response.status).toBe(201);
  const delivery = await claim(fixture);
  expect(delivery).not.toBeNull();
  if (!delivery) throw new Error("Sent Message was not claimed");
  return delivery;
}

function receiptRequest(app: App, workspaceId: string, headers: Record<string, string>, delivery: Claim, verb: string) {
  return app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/deliveries/${delivery.deliveryId}/${verb}`, {
    method: "POST", headers, body: JSON.stringify({ receipt: delivery.receipt }),
  }));
}

async function deliveryRow(admin: Pool, deliveryId: string) {
  const [row] = await admin<{ data: { state: string; chain_id: string; receipt_token_hash: string | null; next_attempt_at: string | null } }[]>`SELECT to_jsonb(d) AS data FROM queue.deliveries d WHERE id = ${deliveryId}`;
  if (!row) throw new Error("Delivery row missing");
  return row.data;
}

async function dispatch(admin: Pool, workspaceId: string, queue: string) {
  const [row] = await admin<{ pgmq_queue: string }[]>`SELECT pgmq_queue FROM queue.queues WHERE workspace_id = ${workspaceId} AND name = ${queue}`;
  if (!row) throw new Error("Queue storage missing");
  return row.pgmq_queue;
}

test("foreign Receipt accepts a different Principal, Run or Workspace and changes the Delivery", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const fixture = await queueFixture(pool);
    const { app, cookie, workspaceId, key, headers } = fixture;
    const delivery = await sendAndClaim(fixture);
    const before = await deliveryRow(admin, delivery.deliveryId);
    const principalResponse = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Foreign consumer" }),
    }));
    expect(principalResponse.status).toBe(201);
    const principal = await principalResponse.json() as { id: string };
    const foreignKey = await issueKey(app, cookie, workspaceId, principal.id);
    const foreignRun = await createRun(app, foreignKey, workspaceId);
    const foreignHeaders = { ...headers, authorization: `Bearer ${foreignKey}`, "x-backplane-run": foreignRun };
    const foreign = await receiptRequest(app, workspaceId, foreignHeaders, delivery, "ack");
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "receipt_foreign" });
    const otherRun = await createRun(app, key, workspaceId);
    const wrongRun = await receiptRequest(app, workspaceId, { ...headers, "x-backplane-run": otherRun }, delivery, "ack");
    expect(wrongRun.status).toBe(403);
    expect(await wrongRun.json()).toEqual({ error: "receipt_foreign" });

    const workspaceResponse = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Foreign Workspace" }),
    }));
    expect(workspaceResponse.status).toBe(201);
    const workspace = await workspaceResponse.json() as { id: string };
    const otherPrincipalResponse = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspace.id}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Other Workspace consumer" }),
    }));
    expect(otherPrincipalResponse.status).toBe(201);
    const otherPrincipal = await otherPrincipalResponse.json() as { id: string };
    const otherKey = await issueKey(app, cookie, workspace.id, otherPrincipal.id);
    const otherWorkspaceRun = await createRun(app, otherKey, workspace.id);
    const crossWorkspace = await receiptRequest(app, workspace.id, { ...headers, authorization: `Bearer ${otherKey}`, "x-backplane-run": otherWorkspaceRun }, delivery, "renew");
    expect(crossWorkspace.status).toBe(404);
    expect(await crossWorkspace.json()).toEqual({ error: "delivery_not_found" });
    expect(await deliveryRow(admin, delivery.deliveryId)).toEqual(before);
    expect(await pool<{ reason: string }[]>`SELECT reason FROM audit.rejections WHERE kind = 'queue.ack'`).toEqual([
      { reason: "receipt_foreign" }, { reason: "receipt_foreign" },
    ]);
    expect(await pool<{ position: bigint }[]>`SELECT position FROM audit.events WHERE kind IN ('queue.ack', 'queue.renew')`).toEqual([]);

    const badToken = await receiptRequest(app, workspaceId, foreignHeaders, { ...delivery, receipt: `${delivery.receipt}bad` }, "ack");
    expect(badToken.status).toBe(409);
    expect(await badToken.json()).toEqual({ error: "receipt_stale" });
    expect(await deliveryRow(admin, delivery.deliveryId)).toEqual(before);
    const ack = await receiptRequest(app, workspaceId, headers, delivery, "ack");
    expect(ack.status).toBe(200);
    const completed = await deliveryRow(admin, delivery.deliveryId);
    expect(completed.state).toBe("succeeded");
    const staleForeign = await receiptRequest(app, workspaceId, foreignHeaders, delivery, "ack");
    expect(staleForeign.status).toBe(409);
    expect(await staleForeign.json()).toEqual({ error: "receipt_stale" });
    expect(await deliveryRow(admin, delivery.deliveryId)).toEqual(completed);
    expect(await pool<{ metadata: string }[]>`SELECT metadata::text FROM audit.events WHERE kind = 'queue.ack'`)
      .toEqual([{ metadata: '{"state": "succeeded", "attempt": 1}' }]);
  } finally {
    await pool.close();
    await admin.close();
  }
});

test("expired or stale Receipt renews or acknowledges a successor Delivery", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const fixture = await queueFixture(pool);
    const { app, workspaceId, principalId, runId, headers, queue } = fixture;
    const original = await sendAndClaim(fixture);
    const physical = await dispatch(admin, workspaceId, queue);
    // Explicit clock fault injection exercises expiry without a 30-second lease wait.
    await withRunContext(admin, { workspaceId, principalId, runId }, async (tx) => {
      await tx`UPDATE queue.deliveries SET lease_expires_at = clock_timestamp() - interval '10 seconds' WHERE id = ${original.deliveryId}`;
      await tx`SELECT pgmq.set_vt(${physical}, pgmq_msg_id, clock_timestamp()) FROM queue.deliveries WHERE id = ${original.deliveryId}`;
    });
    const expired = await receiptRequest(app, workspaceId, headers, original, "renew");
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({ error: "receipt_expired" });
    const successor = await claim(fixture);
    if (!successor) throw new Error("Successor Delivery missing");
    expect(successor).toMatchObject({ messageId: original.messageId, attempt: 2 });
    expect(successor.deliveryId).not.toBe(original.deliveryId);
    expect(successor.receipt).not.toBe(original.receipt);
    const originalRow = await deliveryRow(admin, original.deliveryId);
    const successorRow = await deliveryRow(admin, successor.deliveryId);
    expect(originalRow).toMatchObject({ current: false, state: "scheduled", receipt_token_hash: null, failure_code: "expire" });
    expect(successorRow).toMatchObject({ current: true, parent_id: original.deliveryId, chain_id: originalRow.chain_id });
    expect(await pool<{ kind: string; objects: string[]; metadata: string }[]>`SELECT kind, objects, metadata::text FROM audit.events WHERE kind IN ('queue.claim', 'queue.expire') ORDER BY position`)
      .toEqual([
        { kind: "queue.claim", objects: [queue, original.messageId, original.deliveryId], metadata: '{"state": "leased", "attempt": 1}' },
        { kind: "queue.expire", objects: [queue, original.messageId, original.deliveryId], metadata: '{"state": "scheduled", "attempt": 1}' },
        { kind: "queue.claim", objects: [queue, original.messageId, successor.deliveryId], metadata: '{"state": "leased", "attempt": 2}' },
      ]);
    const stale = await receiptRequest(app, workspaceId, headers, original, "ack");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "receipt_stale" });
    const ack = await receiptRequest(app, workspaceId, headers, successor, "ack");
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ deliveryId: successor.deliveryId, state: "succeeded" });
    expect(await pool<{ metadata: string }[]>`SELECT metadata::text FROM audit.events WHERE kind = 'queue.ack'`)
      .toEqual([{ metadata: '{"state": "succeeded", "attempt": 2}' }]);
    expect(await admin<{ msg_id: bigint }[]>`SELECT msg_id FROM pgmq.${admin(`q_${physical}`)}`).toEqual([]);
    expect(await admin<{ msg_id: bigint }[]>`SELECT msg_id FROM pgmq.${admin(`a_${physical}`)}`).toHaveLength(1);
    expect(await pool<{ reason: string }[]>`SELECT reason FROM audit.rejections WHERE kind = 'queue.renew'`).toEqual([{ reason: "receipt_expired" }]);
    expect(await pool<{ reason: string }[]>`SELECT reason FROM audit.rejections WHERE kind = 'queue.ack'`).toEqual([{ reason: "receipt_stale" }]);
  } finally {
    await pool.close();
    await admin.close();
  }
});

test("revoked Principal acknowledges a leased Delivery or binds a new transaction", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const fixture = await queueFixture(pool);
    const { app, cookie, workspaceId, principalId, runId, headers } = fixture;
    const delivery = await sendAndClaim(fixture);
    const before = await deliveryRow(admin, delivery.deliveryId);
    const revoked = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals/${principalId}/revoke`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" },
    }));
    expect(revoked.status).toBe(200);
    const ack = await receiptRequest(app, workspaceId, headers, delivery, "ack");
    expect(ack.status).toBe(401);
    await expect(withRunContext(pool, { workspaceId, principalId, runId }, async () => "bound"))
      .rejects.toMatchObject({ message: "principal_revoked" });
    expect(await deliveryRow(admin, delivery.deliveryId)).toEqual(before);
    expect(before.state).toBe("leased");
    expect(await pool<{ position: bigint }[]>`SELECT position FROM audit.events WHERE kind = 'queue.ack'`).toEqual([]);
  } finally {
    await pool.close();
    await admin.close();
  }
});

test("renew and ack race revives completed work or nack bypasses backoff and the attempt limit", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const fixture = await queueFixture(pool);
    const { app, workspaceId, headers, queue } = fixture;
    const delivery = await sendAndClaim(fixture);
    const before = await deliveryRow(admin, delivery.deliveryId);
    const physical = await dispatch(admin, workspaceId, queue);
    const renewed = await receiptRequest(app, workspaceId, headers, delivery, "renew");
    expect(renewed.status).toBe(200);
    const renewal = await renewed.json() as { deliveryId: string; leaseExpiresAt: string };
    expect(renewal.deliveryId).toBe(delivery.deliveryId);
    expect(Date.parse(renewal.leaseExpiresAt)).toBeGreaterThanOrEqual(Date.parse(delivery.leaseExpiresAt));
    expect((await deliveryRow(admin, delivery.deliveryId)).receipt_token_hash).toBe(before.receipt_token_hash);
    expect(await admin<{ matching: boolean }[]>`SELECT q.vt = d.lease_expires_at AS matching FROM pgmq.${admin(`q_${physical}`)} q
      JOIN queue.deliveries d ON d.pgmq_msg_id = q.msg_id WHERE d.id = ${delivery.deliveryId}`).toEqual([{ matching: true }]);
    const ack = await receiptRequest(app, workspaceId, headers, delivery, "ack");
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ deliveryId: delivery.deliveryId, state: "succeeded" });
    const stale = await receiptRequest(app, workspaceId, headers, delivery, "renew");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "receipt_stale" });
    expect(await claim(fixture)).toBeNull();

    let retry = await sendAndClaim(fixture, "retry");
    const retryMessageId = retry.messageId;
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(retry.attempt).toBe(attempt);
      const nacked = await receiptRequest(app, workspaceId, headers, retry, "nack");
      expect(nacked.status).toBe(200);
      const result = await nacked.json() as Nack;
      expect(result).toMatchObject({ deliveryId: retry.deliveryId, state: attempt === 5 ? "dead-lettered" : "scheduled" });
      const row = await deliveryRow(admin, retry.deliveryId);
      expect(row).toMatchObject({ state: result.state, receipt_token_hash: null, failure_code: "nack" });
      if (attempt === 5) {
        expect(result.nextAttemptAt).toBeNull();
        break;
      }
      expect(row.next_attempt_at).toBe(result.nextAttemptAt);
      const [schedule] = await admin<{ matching: boolean; backoff: number; remaining: number }[]>`
        SELECT q.vt = d.next_attempt_at AS matching,
          extract(epoch FROM d.next_attempt_at - d.completed_at)::float8 AS backoff,
          greatest(0, extract(epoch FROM d.next_attempt_at - clock_timestamp()) * 1000)::float8 AS remaining
        FROM queue.deliveries d JOIN pgmq.${admin(`q_${physical}`)} q ON q.msg_id = d.pgmq_msg_id
        WHERE d.id = ${retry.deliveryId}`;
      if (!schedule) throw new Error("Scheduled dispatch row missing");
      expect(schedule.matching).toBe(true);
      expect(schedule.backoff).toBeGreaterThan(4.5);
      expect(schedule.backoff).toBeLessThanOrEqual(5);
      expect(await claim(fixture)).toBeNull();
      await Bun.sleep(schedule.remaining + 25);
      const successor = await claim(fixture);
      if (!successor) throw new Error("Retry Delivery missing");
      expect(successor).toMatchObject({ messageId: retryMessageId, attempt: attempt + 1 });
      expect(successor.deliveryId).not.toBe(retry.deliveryId);
      expect(successor.receipt).not.toBe(retry.receipt);
      retry = successor;
    }
    expect(await claim(fixture)).toBeNull();
    expect(await admin<{ msg_id: bigint }[]>`SELECT msg_id FROM pgmq.${admin(`q_${physical}`)}`).toEqual([]);
    expect(await admin<{ msg_id: bigint }[]>`SELECT msg_id FROM pgmq.${admin(`a_${physical}`)}`).toHaveLength(2);
    expect(await admin<{ state: string; attempt: number }[]>`SELECT state, attempt FROM queue.deliveries WHERE message_id = ${retryMessageId} ORDER BY attempt`)
      .toEqual([
        { state: "scheduled", attempt: 1 }, { state: "scheduled", attempt: 2 },
        { state: "scheduled", attempt: 3 }, { state: "scheduled", attempt: 4 }, { state: "dead-lettered", attempt: 5 },
      ]);
    expect(await pool<{ kind: string; metadata: string }[]>`SELECT kind, metadata::text FROM audit.events WHERE kind IN ('queue.claim', 'queue.renew', 'queue.ack', 'queue.nack') ORDER BY position`)
      .toEqual([
        { kind: "queue.claim", metadata: '{"state": "leased", "attempt": 1}' },
        { kind: "queue.renew", metadata: '{"state": "leased", "attempt": 1}' },
        { kind: "queue.ack", metadata: '{"state": "succeeded", "attempt": 1}' },
        { kind: "queue.claim", metadata: '{"state": "leased", "attempt": 1}' },
        { kind: "queue.nack", metadata: '{"state": "scheduled", "attempt": 1}' },
        { kind: "queue.claim", metadata: '{"state": "leased", "attempt": 2}' },
        { kind: "queue.nack", metadata: '{"state": "scheduled", "attempt": 2}' },
        { kind: "queue.claim", metadata: '{"state": "leased", "attempt": 3}' },
        { kind: "queue.nack", metadata: '{"state": "scheduled", "attempt": 3}' },
        { kind: "queue.claim", metadata: '{"state": "leased", "attempt": 4}' },
        { kind: "queue.nack", metadata: '{"state": "scheduled", "attempt": 4}' },
        { kind: "queue.claim", metadata: '{"state": "leased", "attempt": 5}' },
        { kind: "queue.nack", metadata: '{"state": "dead-lettered", "attempt": 5}' },
      ]);
  } finally {
    await pool.close();
    await admin.close();
  }
}, 35000);
