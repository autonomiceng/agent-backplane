import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createPool } from "../platform/pool.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { createRun, issueKey, queueFixture } from "../testing/session.ts";
import type { Claim } from "./claim-input.ts";
import { claimIn } from "./claim.ts";
import type { Message } from "./send-message-input.ts";

test("concurrent double claim duplicates a Message or leaves a lease after adapter rollback", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const { app, cookie, headers, workspaceId, principalId, runId, queue, messagesUrl } = await queueFixture(pool);
    const privileges = await admin<{
      server_select: boolean; principal_claim: boolean; queue_read: boolean; queue_set_vt: boolean; queue_archive: boolean;
    }[]>`
      SELECT has_table_privilege('bp_server', 'queue.deliveries', 'SELECT') AS server_select,
        has_function_privilege(role_name, 'queue.claim(uuid,text,bytea)', 'EXECUTE') AS principal_claim,
        has_function_privilege('bp_queue', 'pgmq.read(text,integer,integer,jsonb)', 'EXECUTE') AS queue_read,
        has_function_privilege('bp_queue', 'pgmq.set_vt(text,bigint,timestamptz)', 'EXECUTE') AS queue_set_vt,
        has_function_privilege('bp_queue', 'pgmq.archive(text,bigint)', 'EXECUTE') AS queue_archive
      FROM control.principals WHERE workspace_id = ${workspaceId} AND id = ${principalId}`;
    expect(privileges).toEqual([{
      server_select: false, principal_claim: false, queue_read: true, queue_set_vt: true, queue_archive: true,
    }]);
    const firstSend = await app.handle(new Request(messagesUrl, {
      method: "POST", headers, body: JSON.stringify({ idempotencyKey: "first", payload: { task: "first" } }),
    }));
    const secondSend = await app.handle(new Request(messagesUrl, {
      method: "POST", headers, body: JSON.stringify({ idempotencyKey: "second", payload: null }),
    }));
    expect([firstSend.status, secondSend.status]).toEqual([201, 201]);
    const messages = [await firstSend.json() as Message, await secondSend.json() as Message];
    const created = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Second consumer" }),
    }));
    expect(created.status).toBe(201);
    const secondPrincipal = await created.json() as { id: string };
    const secondKey = await issueKey(app, cookie, workspaceId, secondPrincipal.id);
    const secondRun = await createRun(app, secondKey, workspaceId);
    const secondHeaders = { ...headers, authorization: `Bearer ${secondKey}`, "x-backplane-run": secondRun };
    const claimUrl = `http://localhost/api/v1/workspaces/${workspaceId}/queues/${queue}/claim`;
    const responses = await Promise.all([
      app.handle(new Request(claimUrl, { method: "POST", headers, body: "{}" })),
      app.handle(new Request(claimUrl, { method: "POST", headers: secondHeaders, body: "{}" })),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const claims = await Promise.all(responses.map(async (response) => await response.json() as Claim));
    expect(claims.map((claim) => claim.messageId).sort()).toEqual(messages.map((message) => message.id).sort());
    expect(claims.map((claim) => claim.payload)).toContainEqual(null);
    expect(claims.map((claim) => claim.payload)).toContainEqual({ task: "first" });
    const empty = await app.handle(new Request(claimUrl, { method: "POST", headers, body: "{}" }));
    expect(empty.status).toBe(200);
    expect(empty.headers.get("Cache-Control")).toBe("no-store");
    expect(empty.headers.get("content-type")).toContain("application/json");
    expect(await empty.text()).toBe("null");
    const rows = await admin<{ id: string; message_id: string; state: string; consumer_principal_id: string; consumer_run_id: string; receipt_token_hash: Buffer }[]>`
      SELECT * FROM queue.deliveries WHERE workspace_id = ${workspaceId}`;
    expect(rows).toHaveLength(2);
    const [firstClaim, secondClaim] = claims;
    if (!firstClaim || !secondClaim) throw new Error("Both consumers must receive a Delivery");
    for (const [claim, consumer, run] of [[firstClaim, principalId, runId], [secondClaim, secondPrincipal.id, secondRun]] as const) {
      const row = rows.find((delivery) => delivery.id === claim.deliveryId);
      expect(row).toMatchObject({ message_id: claim.messageId, state: "leased", consumer_principal_id: consumer, consumer_run_id: run });
      expect(row?.receipt_token_hash).toEqual(createHash("sha256").update(claim.receipt).digest());
      expect(Buffer.from(claim.receipt, "base64url")).toHaveLength(32);
      expect(claim.attempt).toBe(1);
      const events = await pool`SELECT * FROM audit.events WHERE workspace_id = ${workspaceId}`;
      const stored = await admin`SELECT to_jsonb(d)::text AS row FROM queue.deliveries d`;
      expect(JSON.stringify(stored)).not.toContain(claim.receipt);
      expect(JSON.stringify(events)).not.toContain(claim.receipt);
    }
    const claimEvents = await pool<{ principal_id: string; run_id: string; objects: string[] }[]>`SELECT principal_id, run_id, objects FROM audit.events WHERE kind = 'queue.claim' ORDER BY position`;
    expect(claimEvents).toHaveLength(2);
    expect(claimEvents).toEqual(expect.arrayContaining([
        { principal_id: principalId, run_id: runId, objects: [queue, firstClaim.messageId, firstClaim.deliveryId] },
        { principal_id: secondPrincipal.id, run_id: secondRun, objects: [queue, secondClaim.messageId, secondClaim.deliveryId] },
      ]));

    const rollbackSend = await app.handle(new Request(messagesUrl, {
      method: "POST", headers, body: JSON.stringify({ idempotencyKey: "rollback", payload: "rollback" }),
    }));
    expect(rollbackSend.status).toBe(201);
    const rollbackMessage = await rollbackSend.json() as Message;
    await expect(withRunContext(pool, { workspaceId, principalId, runId }, async (tx, emit) => {
      const claimed = await claimIn(tx, emit, workspaceId, queue);
      expect(claimed?.messageId).toBe(rollbackMessage.id);
      throw new Error("adapter_failed_after_claim");
    })).rejects.toThrow("adapter_failed_after_claim");
    expect(await admin<{ state: string; attempt: number }[]>`SELECT state, attempt FROM queue.deliveries WHERE message_id = ${rollbackMessage.id}`)
      .toEqual([{ state: "ready", attempt: 1 }]);
    expect(await pool<{ position: bigint }[]>`SELECT position FROM audit.events WHERE kind = 'queue.claim' AND ${rollbackMessage.id} = ANY(objects)`).toEqual([]);
    const retry = await app.handle(new Request(claimUrl, { method: "POST", headers, body: "{}" }));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ messageId: rollbackMessage.id, attempt: 1 });

    for (const [delivery, consumerHeaders, verb] of [
      [firstClaim, headers, "renew"], [firstClaim, headers, "ack"], [secondClaim, secondHeaders, "nack"],
    ] as const) {
      const response = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/deliveries/${delivery.deliveryId}/${verb}`, {
        method: "POST", headers: consumerHeaders, body: JSON.stringify({ receipt: delivery.receipt }),
      }));
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain(firstClaim.receipt);
      expect(body).not.toContain(secondClaim.receipt);
    }
    const rejected = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/deliveries/${firstClaim.deliveryId}/ack`, {
      method: "POST", headers, body: JSON.stringify({ receipt: firstClaim.receipt }),
    }));
    expect(rejected.status).toBe(409);
    const rejectedBody = await rejected.text();
    expect(rejectedBody).not.toContain(firstClaim.receipt);
    expect(rejectedBody).not.toContain(secondClaim.receipt);
    const rejections = await admin<{ row: string }[]>`SELECT to_jsonb(r)::text AS row FROM audit.rejections r`;
    expect(rejections).toHaveLength(1);
    expect(JSON.stringify(rejections)).not.toContain(firstClaim.receipt);
    expect(JSON.stringify(rejections)).not.toContain(secondClaim.receipt);
  } finally {
    await pool.close();
    await admin.close();
  }
});
