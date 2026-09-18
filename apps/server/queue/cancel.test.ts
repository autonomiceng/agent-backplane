import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { advanceDeliveryClock, recoveryFixture } from "../testing/session.ts";
import type { Claim } from "./claim-input.ts";
import type { ListDeliveries } from "./list-deliveries-input.ts";

test("cancel races claim and revives cancelled work or accepts a completed Delivery", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const fixture = await recoveryFixture(pool);
    expect((await fixture.send("ready")).status).toBe(201);
    const readyResponse = await fixture.list("?state=ready");
    expect(readyResponse.status).toBe(200);
    const ready = (await readyResponse.json() as ListDeliveries).items[0]!;
    const cancelled = await fixture.cancel(ready.id);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ id: ready.id, state: "cancelled" });
    const empty = await fixture.claim();
    expect(empty.status).toBe(200);
    expect(await empty.json()).toBeNull();

    expect((await fixture.send("leased")).status).toBe(201);
    const claimed = await fixture.claim();
    expect(claimed.status).toBe(200);
    const leased = await claimed.json() as Claim;
    const conflict = await fixture.cancel(leased.deliveryId);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "delivery_conflict" });
    const forced = await fixture.cancel(leased.deliveryId, true);
    expect(forced.status).toBe(200);
    expect(await forced.json()).toMatchObject({ id: leased.deliveryId, state: "cancelled" });
    const stale = await fixture.receipt(leased.deliveryId, leased.receipt, "ack");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "receipt_stale" });

    expect((await fixture.send("scheduled")).status).toBe(201);
    const retryResponse = await fixture.claim();
    expect(retryResponse.status).toBe(200);
    const retry = await retryResponse.json() as Claim;
    expect((await fixture.receipt(retry.deliveryId, retry.receipt, "nack")).status).toBe(200);
    const scheduledCancel = await fixture.cancel(retry.deliveryId, false, "duplicate_work");
    expect(scheduledCancel.status).toBe(200);
    expect(await scheduledCancel.json()).toMatchObject({ id: retry.deliveryId, state: "cancelled", nextAttemptAt: null });
    const listed = await fixture.list("?state=cancelled");
    expect(listed.status).toBe(200);
    const cancellations = await listed.json() as ListDeliveries;
    expect(cancellations.items.map((item) => item.id)).toEqual([ready.id, leased.deliveryId, retry.deliveryId]);
    expect(await pool<{ metadata: unknown; user_id: string | null }[]>`
      SELECT metadata, user_id FROM audit.events WHERE kind = 'queue.cancel' AND ${retry.deliveryId} = ANY(objects)`)
      .toEqual([{ metadata: { state: "cancelled", attempt: 1, reason: "duplicate_work" }, user_id: expect.any(String) }]);
    const afterCancel = await fixture.claim();
    expect(afterCancel.status).toBe(200);
    expect(await afterCancel.json()).toBeNull();

    expect((await fixture.send("succeeded")).status).toBe(201);
    const completeResponse = await fixture.claim();
    expect(completeResponse.status).toBe(200);
    const complete = await completeResponse.json() as Claim;
    expect((await fixture.receipt(complete.deliveryId, complete.receipt, "ack")).status).toBe(200);
    const succeededCancel = await fixture.cancel(complete.deliveryId, true);
    expect(succeededCancel.status).toBe(409);
    expect(await succeededCancel.json()).toEqual({ error: "delivery_conflict" });
    expect(await pool<{ reason: string }[]>`SELECT reason FROM audit.rejections WHERE kind = 'queue.cancel' ORDER BY id`)
      .toEqual([{ reason: "delivery_conflict" }, { reason: "delivery_conflict" }]);
  } finally { await pool.close(); }
});

test("unfenced worker renews, acknowledges or nacks after force cancel or expiry-driven reclaim", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const fixture = await recoveryFixture(pool);
    const { workspaceId, principalId, runId } = fixture;
    expect((await fixture.send("cancelled")).status).toBe(201);
    const firstResponse = await fixture.claim();
    expect(firstResponse.status).toBe(200);
    const cancelled = await firstResponse.json() as Claim;
    expect((await fixture.cancel(cancelled.deliveryId, true)).status).toBe(200);
    const cancelledBefore = await pool`SELECT envelope FROM queue.delivery_envelopes WHERE id = ${cancelled.deliveryId}`;
    for (const verb of ["renew", "ack", "nack"]) {
      const response = await fixture.receipt(cancelled.deliveryId, cancelled.receipt, verb);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "receipt_stale" });
      expect(await pool`SELECT envelope FROM queue.delivery_envelopes WHERE id = ${cancelled.deliveryId}`).toEqual(cancelledBefore);
    }

    expect((await fixture.send("expired")).status).toBe(201);
    const originalResponse = await fixture.claim();
    expect(originalResponse.status).toBe(200);
    const original = await originalResponse.json() as Claim;
    await advanceDeliveryClock(admin, { workspaceId, principalId, runId }, original.deliveryId, "leased");
    const reclaimed = await fixture.claim();
    expect(reclaimed.status).toBe(200);
    const successor = await reclaimed.json() as Claim;
    expect(successor).toMatchObject({ messageId: original.messageId, attempt: 2 });
    expect(successor.deliveryId).not.toBe(original.deliveryId);
    expect(successor.receipt).not.toBe(original.receipt);
    const before = await pool`SELECT envelope FROM queue.delivery_envelopes
      WHERE envelope->>'message_id' = ${original.messageId} ORDER BY created_at, id`;
    for (const verb of ["renew", "ack", "nack"]) {
      const response = await fixture.receipt(original.deliveryId, original.receipt, verb);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "receipt_stale" });
      expect(await pool`SELECT envelope FROM queue.delivery_envelopes
        WHERE envelope->>'message_id' = ${original.messageId} ORDER BY created_at, id`).toEqual(before);
    }
    const current = await fixture.list("?state=leased");
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ items: [{ id: successor.deliveryId, state: "leased", current: true }], nextCursor: null });
  } finally {
    await pool.close();
    await admin.close();
  }
});
