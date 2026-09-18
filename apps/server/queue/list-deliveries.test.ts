import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { advanceDeliveryClock, recoveryFixture, signUp } from "../testing/session.ts";
import type { Claim } from "./claim-input.ts";
import type { ListDeliveries } from "./list-deliveries-input.ts";

test("premature retry bypasses backoff or sent Deliveries are invisible to authorized actors", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const fixture = await recoveryFixture(pool);
    const { app, workspaceId, queue, cookie } = fixture;
    expect((await fixture.send("first")).status).toBe(201);
    const principalResponse = await fixture.list("?state=ready");
    expect(principalResponse.status).toBe(200);
    expect(principalResponse.headers.get("Cache-Control")).toBe("no-store");
    const ready = await principalResponse.json() as ListDeliveries;
    expect(ready.items).toHaveLength(1);
    const original = ready.items[0]!;
    expect(original).toMatchObject({ workspaceId, queue, state: "ready", current: true, attempt: 1 });
    expect(JSON.stringify(ready)).not.toMatch(/receipt|pgmq/i);
    const userResponse = await fixture.list("?state=ready", { cookie });
    expect(userResponse.status).toBe(200);
    expect(await userResponse.json()).toEqual(ready);
    const outsider = await signUp(app, "outsider@example.com");
    const [outsiderUser] = await pool<{ id: string }[]>`SELECT id FROM control."user" WHERE email = 'outsider@example.com'`;
    if (!outsiderUser) throw new Error("Outsider User missing");
    // Sign-up enrolls every User in default; this isolated fixture needs a second Organization.
    await admin`DROP INDEX control.organization_singleton`;
    await admin`INSERT INTO control.organization (id, name, slug, "createdAt") VALUES ('other', 'Other', 'other', now())`;
    await admin`UPDATE control.member SET "organizationId" = 'other' WHERE "userId" = ${outsiderUser.id}`;
    expect((await fixture.list("", { cookie: outsider })).status).toBe(403);
    expect((await fixture.list("", { cookie, authorization: "invalid" })).status).toBe(401);

    const claimedResponse = await fixture.claim();
    expect(claimedResponse.status).toBe(200);
    const claimed = await claimedResponse.json() as Claim;
    expect(claimed.deliveryId).toBe(original.id);
    expect((await fixture.receipt(claimed.deliveryId, claimed.receipt, "nack")).status).toBe(200);
    const scheduledResponse = await fixture.list("?state=scheduled");
    expect(scheduledResponse.status).toBe(200);
    const scheduled = await scheduledResponse.json() as ListDeliveries;
    expect(scheduled.items).toHaveLength(1);
    expect(scheduled.items[0]).toMatchObject({ id: original.id, state: "scheduled", current: true });
    const early = await fixture.claim();
    expect(early.status).toBe(200);
    expect(await early.json()).toBeNull();
    await pool`SELECT pg_sleep(greatest(0, extract(epoch FROM ${scheduled.items[0]!.nextAttemptAt}::timestamptz - clock_timestamp())) + 0.025)`;
    const retryResponse = await fixture.claim();
    expect(retryResponse.status).toBe(200);
    const retry = await retryResponse.json() as Claim;
    expect(retry).toMatchObject({ messageId: original.messageId, attempt: 2 });
    expect(retry.deliveryId).not.toBe(original.id);

    const firstPage = await fixture.list("?limit=1");
    expect(firstPage.status).toBe(200);
    const page = await firstPage.json() as ListDeliveries;
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: original.id, current: false });
    expect(page.nextCursor).toBeString();
    const secondPage = await fixture.list(`?limit=1&after=${page.nextCursor}`);
    expect(secondPage.status).toBe(200);
    expect(await secondPage.json()).toMatchObject({ items: [{ id: retry.deliveryId, current: true }], nextCursor: null });
    expect((await fixture.list(`?state=scheduled&after=${page.nextCursor}`)).status).toBe(422);
    expect((await fixture.list("?after=invalid")).status).toBe(422);
    expect((await fixture.list("?limit=101")).status).toBe(422);
    expect((await fixture.list("?state=invalid")).status).toBe(422);
    expect((await fixture.send("first")).status).toBe(200);
    expect(await pool<{ count: number }[]>`SELECT count(*)::int AS count FROM audit.events WHERE kind = 'queue.ready' AND workspace_id = ${workspaceId}`)
      .toEqual([{ count: 1 }]);
  } finally {
    await pool.close();
    await admin.close();
  }
}, 15000);

test("missing dead-letter limit dispatches a sixth attempt after five nacks", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const fixture = await recoveryFixture(pool);
    const { workspaceId, principalId, runId } = fixture;
    expect((await fixture.send("limit")).status).toBe(201);
    let last: Claim | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const claimed = await fixture.claim();
      expect(claimed.status).toBe(200);
      last = await claimed.json() as Claim;
      expect(last.attempt).toBe(attempt);
      const response = await fixture.receipt(last.deliveryId, last.receipt, "nack");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: attempt === 5 ? "dead-lettered" : "scheduled" });
      if (attempt < 5) await advanceDeliveryClock(admin, { workspaceId, principalId, runId }, last.deliveryId, "scheduled");
    }
    const listed = await fixture.list("?state=dead-lettered");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ items: [{ id: last!.deliveryId, state: "dead-lettered", attempt: 5, current: true }], nextCursor: null });
    const empty = await fixture.claim();
    expect(empty.status).toBe(200);
    expect(await empty.json()).toBeNull();
    expect(await pool<{ attempt: number }[]>`SELECT (envelope->>'attempt')::int AS attempt
      FROM queue.delivery_envelopes WHERE workspace_id = ${fixture.workspaceId} ORDER BY created_at, id`)
      .toEqual([{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }, { attempt: 4 }, { attempt: 5 }]);
  } finally {
    await pool.close();
    await admin.close();
  }
});
