import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { createRun, issueKey, queueFixture } from "../testing/session.ts";
import type { Message } from "./send-message-input.ts";

test("cross-Workspace queue isolation aliases physical storage or grants Principals ledger and PGMQ access", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const { app, cookie, headers, workspaceId, principalId, runId, queue } = await queueFixture(pool);
    const secondWorkspaceResponse = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Other Workspace" }),
    }));
    expect(secondWorkspaceResponse.status).toBe(201);
    const secondWorkspace = await secondWorkspaceResponse.json() as { id: string };
    const secondPrincipalResponse = await app.handle(new Request(`http://localhost/api/v1/workspaces/${secondWorkspace.id}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Other Principal" }),
    }));
    expect(secondPrincipalResponse.status).toBe(201);
    const secondPrincipal = await secondPrincipalResponse.json() as { id: string };
    const secondKey = await issueKey(app, cookie, secondWorkspace.id, secondPrincipal.id);
    const secondRun = await createRun(app, secondKey, secondWorkspace.id);
    const secondHeaders = { ...headers, authorization: `Bearer ${secondKey}`, "x-backplane-run": secondRun };
    const secondQueueUrl = `http://localhost/api/v1/workspaces/${secondWorkspace.id}/queues`;
    const secondQueue = await app.handle(new Request(secondQueueUrl, {
      method: "POST", headers: secondHeaders, body: JSON.stringify({ name: queue }),
    }));
    expect(secondQueue.status).toBe(201);
    expect(await secondQueue.json()).toEqual({ workspaceId: secondWorkspace.id, name: queue, createdAt: expect.any(String) });
    const physical = await admin<{ pgmq_queue: string; owner: string }[]>`
      SELECT q.pgmq_queue, pg_get_userbyid(c.relowner) AS owner FROM queue.queues q
      JOIN pg_class c ON c.oid = to_regclass('pgmq.q_' || q.pgmq_queue) WHERE q.name = ${queue}`;
    expect(physical).toHaveLength(2);
    expect(new Set(physical.map((row) => row.pgmq_queue)).size).toBe(2);
    expect(physical.map((row) => row.owner)).toEqual(["bp_queue", "bp_queue"]);
    expect(await pool<{ principal_id: string; run_id: string; objects: string[] }[]>`SELECT principal_id, run_id, objects FROM audit.events WHERE workspace_id = ${workspaceId} AND kind = 'queue.created'`)
      .toEqual([{ principal_id: principalId, run_id: runId, objects: [queue] }]);
    const duplicate = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/queues`, {
      method: "POST", headers, body: JSON.stringify({ name: queue }),
    }));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "queue_exists" });
    expect(await pool<{ reason: string }[]>`SELECT reason FROM audit.rejections WHERE workspace_id = ${workspaceId} AND kind = 'queue.created'`)
      .toEqual([{ reason: "queue_exists" }]);

    const privateQueue = await app.handle(new Request(secondQueueUrl, {
      method: "POST", headers: secondHeaders, body: JSON.stringify({ name: "private" }),
    }));
    expect(privateQueue.status).toBe(201);
    const privateSend = await app.handle(new Request(`${secondQueueUrl}/private/messages`, {
      method: "POST", headers: secondHeaders, body: JSON.stringify({ idempotencyKey: "private", payload: null }),
    }));
    expect(privateSend.status).toBe(201);
    const privateMessage = await privateSend.json() as Message;
    const privateRead = await app.handle(new Request(`${secondQueueUrl}/private/messages/${privateMessage.id}`, { headers: secondHeaders }));
    expect(privateRead.status).toBe(200);
    expect(await privateRead.json()).toEqual({ ...privateMessage, payload: null });
    const foreignRead = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/queues/private/messages/${privateMessage.id}`, { headers }));
    expect(foreignRead.status).toBe(404);
    const foreignSend = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/queues/private/messages`, {
      method: "POST", headers, body: JSON.stringify({ idempotencyKey: "foreign", payload: null }),
    }));
    expect(foreignSend.status).toBe(404);
    expect(await foreignSend.json()).toEqual({ error: "queue_not_found" });
    expect(await pool<{ id: string }[]>`SELECT id FROM queue.messages`).toEqual([{ id: privateMessage.id }]);

    const privileges = await admin`
      SELECT has_schema_privilege(role_name, 'queue', 'USAGE') AS queue_usage,
        has_schema_privilege(role_name, 'queue', 'CREATE') AS queue_create,
        has_schema_privilege(role_name, 'pgmq', 'USAGE') AS pgmq_usage,
        has_schema_privilege(role_name, 'pgmq', 'CREATE') AS pgmq_create,
        has_function_privilege(role_name, 'queue.create_queue(uuid,text)', 'EXECUTE') AS create_queue,
        has_function_privilege(role_name, 'queue.send_message(uuid,text,text,jsonb)', 'EXECUTE') AS send_message,
        has_function_privilege(role_name, 'queue.payload(uuid,text,uuid)', 'EXECUTE') AS payload,
        has_function_privilege(role_name, 'queue.context(uuid)', 'EXECUTE') AS context
      FROM control.principals WHERE workspace_id = ${workspaceId} AND id = ${principalId}`;
    expect(privileges).toEqual([{
      queue_usage: false, queue_create: false, pgmq_usage: false, pgmq_create: false,
      create_queue: false, send_message: false, payload: false, context: false,
    }]);
  } finally {
    await pool.close();
    await admin.close();
  }
});
