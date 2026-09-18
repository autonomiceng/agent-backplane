import { expect, test } from "bun:test";
import type { AuditPage } from "../events/read-audit-input.ts";
import { createPool } from "../platform/pool.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { advanceDeliveryClock, createRun, recoveryFixture } from "../testing/session.ts";
import type { Claim } from "./claim-input.ts";
import type { DeliveryEnvelope } from "./delivery-envelope.ts";

test("expired begun work gets a replacement Receipt or loses the detecting Run", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const f = await recoveryFixture(pool);
    const { app, workspaceId, principalId, runId, baseUrl, headers } = f;
    const post = (path: string, body: unknown, actorHeaders: Record<string, string> = headers) =>
      app.handle(new Request(`${baseUrl}${path}`, { method: "POST", headers: actorHeaders, body: JSON.stringify(body) }));
    expect((await f.send("expire-begun")).status).toBe(201);
    const originalResponse = await f.claim();
    expect(originalResponse.status).toBe(200);
    const original = await originalResponse.json() as Claim;
    expect((await post(`/deliveries/${original.deliveryId}/begin-effect`, {
      receipt: original.receipt, action: "submit-expiring", destination: "outside",
    })).status).toBe(200);
    const forced = await f.cancel(original.deliveryId, true);
    expect(forced.status).toBe(409);
    expect(await forced.json()).toEqual({ error: "delivery_conflict" });
    await advanceDeliveryClock(admin, { workspaceId, principalId, runId }, original.deliveryId, "leased");
    const expiredAck = await f.receipt(original.deliveryId, original.receipt, "ack");
    expect(expiredAck.status).toBe(409);
    expect(await expiredAck.json()).toEqual({ error: "receipt_expired" });
    const expiredBegin = await post(`/deliveries/${original.deliveryId}/begin-effect`, {
      receipt: original.receipt, action: "submit-expiring", destination: "outside",
    });
    expect(expiredBegin.status).toBe(409);
    expect(await expiredBegin.json()).toEqual({ error: "receipt_expired" });
    expect((await f.send("other-work")).status).toBe(201);
    const detectingRun = await createRun(app, f.key, workspaceId);
    const claim = () => post(`/queues/${f.queue}/claim`, {}, { ...headers, "x-backplane-run": detectingRun });
    const next = await claim();
    expect(next.status).toBe(200);
    const other = await next.json() as Claim;
    expect(other.messageId).not.toBe(original.messageId);
    const empty = await claim();
    expect(empty.status).toBe(200);
    expect(await empty.json()).toBeNull();
    const listing = await f.list("?state=ambiguous");
    expect(listing.status).toBe(200);
    expect((await listing.json() as { items: DeliveryEnvelope[] }).items).toEqual([expect.objectContaining({
      id: original.deliveryId, messageId: original.messageId, state: "ambiguous", current: true,
      consumerPrincipalId: principalId, consumerRunId: runId, nextAttemptAt: null, effectStartedAt: expect.any(String),
    })]);
    const replay = await f.replay(original.deliveryId);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: "delivery_conflict" });
    const release = await post(`/deliveries/${original.deliveryId}/release`, {}, f.userHeaders);
    expect(release.status).toBe(409);
    expect(await release.json()).toEqual({ error: "delivery_conflict" });
    const cancel = await f.cancel(original.deliveryId, true);
    expect(cancel.status).toBe(409);
    expect(await cancel.json()).toEqual({ error: "delivery_conflict" });
    const recovered = await post(`/queues/${f.queue}/recover`, {});
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ created: 0, hasMore: false });
    await expect(withRunContext(pool, { workspaceId, principalId, runId }, async (tx) => {
      await tx`SELECT queue.ensure_delivery(${workspaceId}, ${original.messageId})`;
    })).rejects.toMatchObject({ message: "delivery_conflict" });
    expect(await admin<{ id: string; receipt_token_hash: null }[]>`SELECT id, receipt_token_hash FROM queue.deliveries WHERE message_id = ${original.messageId}`)
      .toEqual([{ id: original.deliveryId, receipt_token_hash: null }]);
    const stale = await f.receipt(original.deliveryId, original.receipt, "ack");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "receipt_stale" });

    expect((await f.send("nack-begun")).status).toBe(201);
    const liveResponse = await f.claim();
    expect(liveResponse.status).toBe(200);
    const live = await liveResponse.json() as Claim;
    expect((await post(`/deliveries/${live.deliveryId}/begin-effect`, {
      receipt: live.receipt, action: "submit-nacking", destination: "outside",
    })).status).toBe(200);
    const nacked = await f.receipt(live.deliveryId, live.receipt, "nack");
    expect(nacked.status).toBe(200);
    expect(await nacked.json()).toEqual({ deliveryId: live.deliveryId, state: "ambiguous", nextAttemptAt: null });
    const afterNack = await claim();
    expect(afterNack.status).toBe(200);
    expect(await afterNack.json()).toBeNull();
    const auditResponse = await app.handle(new Request(`${baseUrl}/audit?limit=500`, { headers }));
    expect(auditResponse.status).toBe(200);
    const { events } = await auditResponse.json() as AuditPage;
    const ambiguous = events.filter((e) => e.kind === "effect.ambiguous");
    expect(ambiguous).toEqual([
      expect.objectContaining({ objects: [f.queue, original.messageId, original.deliveryId], principal_id: principalId,
        run_id: detectingRun, user_id: null, row_count: "1", metadata: { attempt: 1, state: "ambiguous", reason: "lease_expired" } }),
      expect.objectContaining({ objects: [f.queue, live.messageId, live.deliveryId], principal_id: principalId,
        run_id: runId, user_id: null, row_count: "1", metadata: { attempt: 1, state: "ambiguous", reason: "nack" } }),
    ]);
    const nackIndex = events.findIndex((e) => e.kind === "queue.nack" && e.objects.includes(live.deliveryId));
    expect(events[nackIndex + 1]).toEqual(ambiguous[1]);
  } finally {
    await pool.close();
    await admin.close();
  }
});
