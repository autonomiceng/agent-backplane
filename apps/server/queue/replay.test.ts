import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createPool } from "../platform/pool.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { advanceDeliveryClock, recoveryFixture } from "../testing/session.ts";
import type { Claim } from "./claim-input.ts";
import type { DeliveryEnvelope } from "./delivery-envelope.ts";
import type { ListDeliveries } from "./list-deliveries-input.ts";
import { replayIn } from "./replay.ts";

test("replay mutates the immutable Message or commits a successor after adapter failure", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const fixture = await recoveryFixture(pool);
    const { workspaceId, principalId, runId } = fixture;
    const payload = { original: [null, "keep me", 42] };
    expect((await fixture.send("replay", payload)).status).toBe(201);
    let last: Claim | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const claimed = await fixture.claim();
      expect(claimed.status).toBe(200);
      last = await claimed.json() as Claim;
      expect(last.attempt).toBe(attempt);
      expect((await fixture.receipt(last.deliveryId, last.receipt, "nack")).status).toBe(200);
      if (attempt < 5) await advanceDeliveryClock(admin, { workspaceId, principalId, runId }, last.deliveryId, "scheduled");
    }
    if (!last) throw new Error("Dead-lettered Delivery missing");
    const deliveryId = last.deliveryId;
    const before = await pool<{ row: string }[]>`SELECT to_jsonb(m)::text AS row FROM queue.messages m WHERE id = ${last.messageId}`;
    const listed = await fixture.list("?state=dead-lettered");
    expect(listed.status).toBe(200);
    const dead = (await listed.json() as ListDeliveries).items[0]!;
    expect(dead).toMatchObject({ id: deliveryId, state: "dead-lettered", attempt: 5 });
    const principal = await fixture.replay(deliveryId, fixture.headers);
    expect(principal.status).toBe(403);
    expect(await principal.json()).toEqual({ error: "recovery_forbidden" });

    const [user] = await pool<{ id: string }[]>`SELECT id FROM control."user" WHERE email = 'credentials@example.com'`;
    if (!user) throw new Error("User missing");
    const context = { workspaceId: fixture.workspaceId, userId: user.id };
    const rollbackApp = new Elysia().post("/rollback", async ({ status }) => {
      try {
        await withRunContext(pool, context, async (tx, emit) => {
          const successor = await replayIn(tx, emit, context, deliveryId);
          expect(successor.parentId).toBe(deliveryId);
          throw new Error("adapter_failed_after_replay");
        });
      } catch (error) {
        if (error instanceof Error && error.message === "adapter_failed_after_replay") return status(503, { error: error.message });
        throw error;
      }
    });
    const failed = await rollbackApp.handle(new Request("http://localhost/rollback", { method: "POST" }));
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "adapter_failed_after_replay" });
    expect(await pool<{ id: string }[]>`SELECT id FROM queue.delivery_envelopes WHERE envelope->>'parent_id' = ${deliveryId}`).toEqual([]);
    expect(await pool<{ position: string }[]>`SELECT position FROM audit.events WHERE kind = 'queue.replay'`).toEqual([]);
    const afterFailure = await fixture.list("?state=dead-lettered");
    expect(afterFailure.status).toBe(200);
    expect((await afterFailure.json() as ListDeliveries).items).toEqual([dead]);

    const replayed = await fixture.replay(deliveryId);
    expect(replayed.status).toBe(201);
    const successor = await replayed.json() as DeliveryEnvelope;
    expect(successor).toMatchObject({ messageId: last.messageId, attempt: 1, maxAttempts: 5, parentId: deliveryId, state: "ready", current: true });
    expect(successor.id).not.toBe(deliveryId);
    expect(successor.chainId).not.toBe(dead.chainId);
    expect(await pool<{ row: string }[]>`SELECT to_jsonb(m)::text AS row FROM queue.messages m WHERE id = ${last.messageId}`).toEqual(before);
    const claimed = await fixture.claim();
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ deliveryId: successor.id, messageId: last.messageId, attempt: 1, payload });
    const twice = await fixture.replay(deliveryId);
    expect(twice.status).toBe(409);
    expect(await twice.json()).toEqual({ error: "delivery_conflict" });
    expect(await pool<{ reason: string; user_id: string }[]>`SELECT reason, user_id FROM audit.rejections WHERE kind = 'queue.replay'`)
      .toEqual([{ reason: "delivery_conflict", user_id: user.id }]);
    expect(await pool<{ user_id: string; metadata: unknown }[]>`SELECT user_id, metadata FROM audit.events WHERE kind = 'queue.replay'`)
      .toEqual([{ user_id: user.id, metadata: { parentDeliveryId: deliveryId, attempt: 1, state: "ready" } }]);
  } finally {
    await pool.close();
    await admin.close();
  }
});
