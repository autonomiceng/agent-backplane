import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { advanceDeliveryClock, createRun, issueKey, recoveryFixture } from "../testing/session.ts";
import type { Claim } from "./claim-input.ts";

test("stale Receipt holds an expired or reclaimed Delivery, or foreign actors hold another consumer's work", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const fixture = await recoveryFixture(pool);
    const { app, cookie, workspaceId, principalId, runId, queue, key, headers } = fixture;
    expect((await fixture.send("hold")).status).toBe(201);
    const firstResponse = await fixture.claim();
    expect(firstResponse.status).toBe(200);
    const original = await firstResponse.json() as Claim;
    const hold = (delivery: Claim, actorHeaders = headers, targetWorkspaceId = workspaceId) => app.handle(new Request(
      `http://localhost/api/v1/workspaces/${targetWorkspaceId}/deliveries/${delivery.deliveryId}/hold`, {
        method: "POST", headers: actorHeaders, body: JSON.stringify({ receipt: delivery.receipt }),
      },
    ));
    // Bun may return jsonb as text; normalize so subset matching sees objects.
    const readDeliveries = async () => (await admin<{ data: unknown }[]>`
      SELECT to_jsonb(d)::text AS data FROM queue.deliveries d WHERE message_id = ${original.messageId} ORDER BY created_at, id`)
      .map((row) => ({ data: JSON.parse(String(row.data)) as Record<string, unknown> }));
    await advanceDeliveryClock(admin, { workspaceId, principalId, runId }, original.deliveryId, "leased");
    const expiredBefore = await readDeliveries();
    expect(expiredBefore).toMatchObject([{ data: { state: "leased", current: true } }]);
    const expired = await hold(original);
    expect(expired.status).toBe(409);
    expect(await expired.json()).toEqual({ error: "receipt_expired" });
    expect(await readDeliveries()).toEqual(expiredBefore);

    const reclaimedResponse = await fixture.claim();
    expect(reclaimedResponse.status).toBe(200);
    const current = await reclaimedResponse.json() as Claim;
    expect(current).toMatchObject({ messageId: original.messageId, attempt: 2 });
    expect(current.deliveryId).not.toBe(original.deliveryId);
    const before = await readDeliveries();
    expect(before).toMatchObject([{ data: { current: false } }, { data: { state: "leased", current: true } }]);
    const stale = await hold(original);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "receipt_stale" });
    expect(await readDeliveries()).toEqual(before);

    const secondRun = await createRun(app, key, workspaceId);
    const differentRun = await hold(current, { ...headers, "x-backplane-run": secondRun });
    expect(differentRun.status).toBe(403);
    expect(await differentRun.json()).toEqual({ error: "receipt_foreign" });
    expect(await readDeliveries()).toEqual(before);

    const otherPrincipalResponse = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Other consumer" }),
    }));
    expect(otherPrincipalResponse.status).toBe(201);
    const otherPrincipal = await otherPrincipalResponse.json() as { id: string };
    const otherKey = await issueKey(app, cookie, workspaceId, otherPrincipal.id);
    const otherRun = await createRun(app, otherKey, workspaceId);
    const foreignHeaders = { ...headers, authorization: `Bearer ${otherKey}`, "x-backplane-run": otherRun };
    const foreignPrincipal = await hold(current, foreignHeaders);
    expect(foreignPrincipal.status).toBe(403);
    expect(await foreignPrincipal.json()).toEqual({ error: "receipt_foreign" });
    expect(await readDeliveries()).toEqual(before);
    const invalidToken = await hold({ ...current, receipt: `${current.receipt}invalid` }, foreignHeaders);
    expect(invalidToken.status).toBe(409);
    expect(await invalidToken.json()).toEqual({ error: "receipt_stale" });
    expect(await readDeliveries()).toEqual(before);

    const workspaceResponse = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Other Workspace" }),
    }));
    expect(workspaceResponse.status).toBe(201);
    const otherWorkspace = await workspaceResponse.json() as { id: string };
    const foreignWorkspace = await hold(current, headers, otherWorkspace.id);
    expect(foreignWorkspace.status).toBe(403);
    expect(await foreignWorkspace.json()).toEqual({ error: "workspace_forbidden" });
    expect(await readDeliveries()).toEqual(before);

    const held = await hold(current);
    expect(held.status).toBe(200);
    expect(held.headers.get("Cache-Control")).toBe("no-store");
    expect(await held.json()).toMatchObject({ id: current.deliveryId, state: "held", heldBy: principalId, current: true });
    const [stored] = await admin<{ state: string; receipt_token_hash: Buffer | null; held_by: string; pgmq_msg_id: bigint }[]>`
      SELECT state, receipt_token_hash, held_by, pgmq_msg_id FROM queue.deliveries WHERE id = ${current.deliveryId}`;
    expect(stored).toMatchObject({ state: "held", receipt_token_hash: null, held_by: principalId });
    const [physical] = await admin<{ pgmq_queue: string }[]>`
      SELECT pgmq_queue FROM queue.queues WHERE workspace_id = ${workspaceId} AND name = ${queue}`;
    if (!stored || !physical) throw new Error("Held Delivery storage missing");
    expect(await admin<{ msg_id: bigint }[]>`SELECT msg_id FROM pgmq.${admin(`q_${physical.pgmq_queue}`)}`).toEqual([]);
    expect(await admin<{ msg_id: bigint }[]>`SELECT msg_id FROM pgmq.${admin(`a_${physical.pgmq_queue}`)}`)
      .toEqual([{ msg_id: stored.pgmq_msg_id }]);
    const oldAck = await fixture.receipt(current.deliveryId, current.receipt, "ack");
    expect(oldAck.status).toBe(409);
    expect(await oldAck.json()).toEqual({ error: "receipt_stale" });
    expect(await pool<{ principal_id: string; run_id: string; objects: string[]; metadata: unknown }[]>`
      SELECT principal_id, run_id, objects, metadata FROM audit.events WHERE workspace_id = ${workspaceId} AND kind = 'queue.hold'`)
      .toEqual([{ principal_id: principalId, run_id: runId, objects: [queue, original.messageId, current.deliveryId], metadata: { attempt: 2, state: "held" } }]);
    expect(await pool<{ reason: string }[]>`
      SELECT reason FROM audit.rejections WHERE workspace_id = ${workspaceId} AND kind = 'queue.hold' ORDER BY id`)
      .toEqual([
        { reason: "receipt_expired" }, { reason: "receipt_stale" },
        { reason: "receipt_foreign" }, { reason: "receipt_foreign" }, { reason: "receipt_stale" },
      ]);
  } finally {
    await pool.close();
    await admin.close();
  }
});
