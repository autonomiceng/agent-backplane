import { expect, test } from "bun:test";
import { createPool, type Pool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { createRun, issueKey, queueFixture } from "../testing/session.ts";
import type { Message } from "./send-message-input.ts";

async function storedMessageCount(admin: Pool, workspaceId: string, queue: string) {
  const [physical] = await admin<{ pgmq_queue: string }[]>`
    SELECT pgmq_queue FROM queue.queues WHERE workspace_id = ${workspaceId} AND name = ${queue}`;
  if (!physical) throw new Error("Queue storage missing");
  const [row] = await admin<{ count: number; unread: boolean }[]>`
    SELECT count(*)::int AS count, bool_and(read_ct = 0 AND last_read_at IS NULL) AS unread
    FROM pgmq.${admin(`q_${physical.pgmq_queue}`)}`;
  return row;
}

test("duplicate send creates extra storage or emits a second queue.send event", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const { app, headers, workspaceId, queue, messagesUrl } = await queueFixture(pool);
    const body = JSON.stringify({ idempotencyKey: "same-request", payload: { task: "triage" } });
    const responses = await Promise.all([
      app.handle(new Request(messagesUrl, { method: "POST", headers, body })),
      app.handle(new Request(messagesUrl, { method: "POST", headers, body })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    const first = await responses[0]!.json() as Message;
    const second = await responses[1]!.json() as Message;
    expect(second).toEqual(first);
    expect(first.id).toBeString();
    expect(Object.keys(first).sort()).toEqual(["createdAt", "id", "idempotencyKey", "producerPrincipalId", "producerRunId", "queue", "workspaceId"]);
    expect(await storedMessageCount(admin, workspaceId, queue)).toEqual({ count: 1, unread: true });
    expect(await pool<{ id: string }[]>`SELECT id FROM queue.messages WHERE workspace_id = ${workspaceId}`).toEqual([{ id: first.id }]);
    expect(await pool<{ objects: string[] }[]>`SELECT objects FROM audit.events WHERE workspace_id = ${workspaceId} AND kind = 'queue.send'`)
      .toEqual([{ objects: [queue, first.id] }]);
  } finally {
    await pool.close();
    await admin.close();
  }
});

test("idempotency hash conflict overwrites the original payload or leaves an extra row or event", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const { app, headers, workspaceId, queue, messagesUrl, principalId, runId } = await queueFixture(pool);
    const payload = { secret: "original-payload", nested: [null, false, 4] };
    const original = await app.handle(new Request(messagesUrl, {
      method: "POST", headers, body: JSON.stringify({ idempotencyKey: "one-key", payload }),
    }));
    expect(original.status).toBe(201);
    const message = await original.json() as Message;
    const conflict = await app.handle(new Request(messagesUrl, {
      method: "POST", headers, body: JSON.stringify({ idempotencyKey: "one-key", payload: { secret: "replacement" } }),
    }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "idempotency_conflict" });
    const read = await app.handle(new Request(`${messagesUrl}/${message.id}`, { headers: { authorization: headers.authorization } }));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ ...message, payload });
    expect(await storedMessageCount(admin, workspaceId, queue)).toEqual({ count: 1, unread: true });
    expect(await pool<{ id: string }[]>`SELECT id FROM queue.messages WHERE workspace_id = ${workspaceId}`).toEqual([{ id: message.id }]);
    expect(await pool<{ objects: string[] }[]>`SELECT objects FROM audit.events WHERE workspace_id = ${workspaceId} AND kind = 'queue.send'`)
      .toEqual([{ objects: [queue, message.id] }]);
    expect(await pool<{ reason: string; principal_id: string; run_id: string }[]>`SELECT reason, principal_id, run_id FROM audit.rejections WHERE workspace_id = ${workspaceId} AND kind = 'queue.send'`)
      .toEqual([{ reason: "idempotency_conflict", principal_id: principalId, run_id: runId }]);
  } finally {
    await pool.close();
    await admin.close();
  }
});

test("lost producer provenance permits unbound sends, rewrites retry stamps or leaks payload into audit", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const { app, cookie, headers, workspaceId, principalId, runId, queue, messagesUrl } = await queueFixture(pool);
    const secret = "secret-payload-never-an-envelope";
    const body = JSON.stringify({ idempotencyKey: "secret-key-never-an-envelope", payload: secret });
    const original = await app.handle(new Request(messagesUrl, { method: "POST", headers, body }));
    expect(original.status).toBe(201);
    const message = await original.json() as Message;
    expect(message).toMatchObject({ workspaceId, queue, producerPrincipalId: principalId, producerRunId: runId });
    expect(await pool<{ producer_principal_id: string; producer_run_id: string }[]>`SELECT producer_principal_id, producer_run_id FROM queue.messages WHERE id = ${message.id}`)
      .toEqual([{ producer_principal_id: principalId, producer_run_id: runId }]);

    const secondPrincipalResponse = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Retrying Principal" }),
    }));
    expect(secondPrincipalResponse.status).toBe(201);
    const secondPrincipal = await secondPrincipalResponse.json() as { id: string };
    const secondKey = await issueKey(app, cookie, workspaceId, secondPrincipal.id);
    const secondRun = await createRun(app, secondKey, workspaceId);
    const retry = await app.handle(new Request(messagesUrl, {
      method: "POST", headers: { ...headers, authorization: `Bearer ${secondKey}`, "x-backplane-run": secondRun }, body,
    }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(message);
    expect(await pool<{ producer_principal_id: string; producer_run_id: string }[]>`SELECT producer_principal_id, producer_run_id FROM queue.messages WHERE id = ${message.id}`)
      .toEqual([{ producer_principal_id: principalId, producer_run_id: runId }]);
    const events = await pool<{ principal_id: string; run_id: string; objects: string[]; row_count: number; metadata: string }[]>`
      SELECT principal_id, run_id, objects, row_count::int, metadata::text FROM audit.events
      WHERE workspace_id = ${workspaceId} AND kind = 'queue.send'`;
    expect(events).toEqual([{
      principal_id: principalId, run_id: runId, objects: [queue, message.id], row_count: 1,
      metadata: expect.any(String),
    }]);
    expect(events[0]!.metadata).not.toContain(secret);
    expect(events[0]!.metadata).not.toContain("secret-key-never-an-envelope");
    expect(JSON.parse(events[0]!.metadata)).toEqual({ idempotency_key_present: true, bytes: Buffer.byteLength(JSON.stringify(secret)) });
    const read = await app.handle(new Request(`${messagesUrl}/${message.id}`, { headers }));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ ...message, payload: secret });
    await expect(pool`SELECT queue.send_message(${workspaceId}, ${queue}, 'unbound', '{}'::jsonb)`.then())
      .rejects.toMatchObject({ message: "context_missing" });
    expect(await storedMessageCount(admin, workspaceId, queue)).toEqual({ count: 1, unread: true });
  } finally {
    await pool.close();
    await admin.close();
  }
});
