import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { advanceDeliveryClock, recoveryFixture, signUp } from "../testing/session.ts";
import type { Claim } from "./claim-input.ts";
import type { DeliveryEnvelope } from "./delivery-envelope.ts";

test("held work is redispatched before User release or release revives the old Delivery chain", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const fixture = await recoveryFixture(pool);
    const { app, workspaceId, principalId, runId, baseUrl, headers, userHeaders } = fixture;
    const payload = { task: "await review", details: [null, "original"] };
    expect((await fixture.send("release", payload)).status).toBe(201);
    const originalResponse = await fixture.claim();
    expect(originalResponse.status).toBe(200);
    const original = await originalResponse.json() as Claim;
    await advanceDeliveryClock(admin, { workspaceId, principalId, runId }, original.deliveryId, "leased");
    const retryResponse = await fixture.claim();
    expect(retryResponse.status).toBe(200);
    const retry = await retryResponse.json() as Claim;
    expect(retry.attempt).toBe(2);
    const heldResponse = await fixture.receipt(retry.deliveryId, retry.receipt, "hold");
    expect(heldResponse.status).toBe(200);
    const held = await heldResponse.json() as DeliveryEnvelope;
    expect(held).toMatchObject({ id: retry.deliveryId, state: "held", attempt: 2 });
    const firstEmpty = await fixture.claim();
    expect(firstEmpty.status).toBe(200);
    expect(await firstEmpty.json()).toBeNull();
    const secondEmpty = await fixture.claim();
    expect(secondEmpty.status).toBe(200);
    expect(await secondEmpty.json()).toBeNull();

    const release = (actorHeaders: Record<string, string> = userHeaders) => app.handle(new Request(`${baseUrl}/deliveries/${held.id}/release`, {
      method: "POST", headers: actorHeaders, body: "{}",
    }));
    const principal = await release(headers);
    expect(principal.status).toBe(403);
    expect(await principal.json()).toEqual({ error: "recovery_forbidden" });

    const outsiderCookie = await signUp(app, "outsider@example.com");
    const [outsiderUser] = await pool<{ id: string }[]>`SELECT id FROM control."user" WHERE email = 'outsider@example.com'`;
    if (!outsiderUser) throw new Error("Outsider User missing");
    // Sign-up enrolls every User in default; this isolated fixture needs a second Organization.
    await admin`DROP INDEX control.organization_singleton`;
    await admin`INSERT INTO control.organization (id, name, slug, "createdAt") VALUES ('other', 'Other', 'other', now())`;
    await admin`UPDATE control.member SET "organizationId" = 'other' WHERE "userId" = ${outsiderUser.id}`;
    const outsider = await release({ origin: "http://localhost", cookie: outsiderCookie, "content-type": "application/json" });
    expect(outsider.status).toBe(403);
    expect(await outsider.json()).toEqual({ error: "recovery_forbidden" });
    expect(await admin<{ state: string }[]>`SELECT state FROM queue.deliveries WHERE id = ${held.id}`)
      .toEqual([{ state: "held" }]);

    const released = await release();
    expect(released.status).toBe(201);
    expect(released.headers.get("Cache-Control")).toBe("no-store");
    const successor = await released.json() as DeliveryEnvelope;
    expect(successor).toMatchObject({
      messageId: original.messageId, parentId: held.id, attempt: 1, maxAttempts: 5,
      state: "ready", current: true, heldBy: null, heldAt: null,
    });
    expect(successor.id).not.toBe(held.id);
    expect(successor.chainId).not.toBe(held.chainId);
    const claimed = await fixture.claim();
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ deliveryId: successor.id, messageId: original.messageId, attempt: 1, payload });
    const twice = await release();
    expect(twice.status).toBe(409);
    expect(await twice.json()).toEqual({ error: "delivery_conflict" });
    expect(await admin<{ id: string; current: boolean }[]>`
      SELECT id, current FROM queue.deliveries WHERE parent_id = ${held.id}`)
      .toEqual([{ id: successor.id, current: true }]);
    expect(await pool<{ user_id: string; objects: string[]; metadata: unknown }[]>`
      SELECT user_id, objects, metadata FROM audit.events WHERE workspace_id = ${workspaceId} AND kind = 'queue.release'`)
      .toEqual([{ user_id: expect.any(String), objects: [fixture.queue, original.messageId, successor.id], metadata: { attempt: 1, state: "ready" } }]);
    expect(await pool<{ reason: string; user_id: string }[]>`
      SELECT reason, user_id FROM audit.rejections WHERE workspace_id = ${workspaceId} AND kind = 'queue.release' ORDER BY id`)
      .toEqual([
        { reason: "recovery_forbidden", user_id: outsiderUser.id },
        { reason: "delivery_conflict", user_id: expect.any(String) },
      ]);
  } finally {
    await pool.close();
    await admin.close();
  }
});
