import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AuditPage } from "../events/read-audit-input.ts";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { advanceDeliveryClock, createRun, recoveryFixture } from "../testing/session.ts";
import type { BeginEffect } from "./begin-effect-input.ts";
import type { Claim } from "./claim-input.ts";
import type { DeliveryEnvelope } from "./delivery-envelope.ts";

test("attempt-derived or overwritten Effect Keys fail retry and replay identity", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const f = await recoveryFixture(pool);
    const { app, workspaceId, principalId, runId, baseUrl, headers } = f;
    const action = "submit:occurrence-é";
    const destination = "private-destination@example.com";
    const encoded = [action, destination].map((value) => {
      const bytes = Buffer.from(value, "utf8");
      const length = Buffer.alloc(4);
      length.writeInt32BE(bytes.length);
      return Buffer.concat([length, bytes]);
    });
    const effectKey = createHash("sha256").update(Buffer.concat([
      Buffer.from(workspaceId.replaceAll("-", ""), "hex"), ...encoded,
    ])).digest("hex");
    expect((await f.send("effect-key")).status).toBe(201);
    const firstResponse = await f.claim();
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as Claim;
    let last = first;
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(last.attempt).toBe(attempt);
      expect(last.messageId).toBe(first.messageId);
      expect((await f.receipt(last.deliveryId, last.receipt, "nack")).status).toBe(200);
      if (attempt < 5) {
        await advanceDeliveryClock(admin, { workspaceId, principalId, runId }, last.deliveryId, "scheduled");
        const retry = await f.claim();
        expect(retry.status).toBe(200);
        last = await retry.json() as Claim;
        expect(last.deliveryId).not.toBe(first.deliveryId);
      }
    }
    const deadList = await f.list("?state=dead-lettered");
    expect(deadList.status).toBe(200);
    const dead = (await deadList.json() as { items: DeliveryEnvelope[] }).items[0]!;
    const replayResponse = await f.replay(last.deliveryId);
    expect(replayResponse.status).toBe(201);
    const replay = await replayResponse.json() as DeliveryEnvelope;
    expect(replay).toMatchObject({ messageId: first.messageId, parentId: last.deliveryId, attempt: 1 });
    expect(replay.chainId).not.toBe(dead.chainId);
    const claimResponse = await f.claim();
    expect(claimResponse.status).toBe(200);
    const claimed = await claimResponse.json() as Claim;
    expect(claimed.deliveryId).toBe(replay.id);
    const begin = (body: unknown, actorHeaders: Record<string, string> = headers) => app.handle(new Request(
      `${baseUrl}/deliveries/${claimed.deliveryId}/begin-effect`, {
        method: "POST", headers: actorHeaders, body: JSON.stringify(body),
      },
    ));
    const input = { receipt: claimed.receipt, action, destination };
    const invalid = await begin({ ...input, effectKey });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: "invalid_input" });
    const tooManyBytes = await begin({ ...input, action: "é".repeat(513) });
    expect(tooManyBytes.status).toBe(422);
    expect(await tooManyBytes.json()).toEqual({ error: "invalid_input" });
    const nul = await begin({ ...input, destination: "a\0b" });
    expect(nul.status).toBe(422);
    const cookieOnly = await begin(input, { origin: "http://localhost", cookie: f.cookie, "content-type": "application/json" });
    expect(cookieOnly.status).toBe(401);
    const started = await begin(input);
    expect(started.status).toBe(200);
    expect(started.headers.get("Cache-Control")).toBe("no-store");
    const effect = await started.json() as BeginEffect;
    expect(effect).toEqual({ deliveryId: claimed.deliveryId, messageId: first.messageId, effectKey, state: "begun", begunAt: expect.any(String) });
    const repeat = await begin(input);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual(effect);
    const changedAction = await begin({ ...input, action: `${action}:changed` });
    expect(changedAction.status).toBe(409);
    expect(await changedAction.json()).toEqual({ error: "effect_key_conflict" });
    const changedDestination = await begin({ ...input, destination: `${destination}:changed` });
    expect(changedDestination.status).toBe(409);
    expect(await changedDestination.json()).toEqual({ error: "effect_key_conflict" });
    const wrongToken = await begin({ ...input, receipt: "wrong" });
    expect(wrongToken.status).toBe(409);
    expect(await wrongToken.json()).toEqual({ error: "receipt_stale" });
    const foreignRun = await createRun(app, f.key, workspaceId);
    const foreign = await begin(input, { ...headers, "x-backplane-run": foreignRun });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "receipt_foreign" });
    const held = await f.receipt(claimed.deliveryId, claimed.receipt, "hold");
    expect(held.status).toBe(409);
    expect(await held.json()).toEqual({ error: "delivery_conflict" });
    const txHold = await app.handle(new Request(`${baseUrl}/transactions`, {
      method: "POST", headers, body: JSON.stringify({ idempotencyKey: "hold-begun", operations: [
        { hold: { deliveryId: claimed.deliveryId, receipt: claimed.receipt } },
      ] }),
    }));
    expect(txHold.status).toBe(409);
    expect(await txHold.json()).toMatchObject({ error: "delivery_conflict" });
    expect((await f.receipt(claimed.deliveryId, claimed.receipt, "renew")).status).toBe(200);
    const begunList = await f.list("?state=begun");
    expect(begunList.status).toBe(200);
    expect((await begunList.json() as { items: DeliveryEnvelope[] }).items).toHaveLength(1);
    expect((await f.receipt(claimed.deliveryId, claimed.receipt, "ack")).status).toBe(200);
    expect(await admin<{ message_id: string; origin_delivery_id: string; effect_key: string }[]>`SELECT message_id, origin_delivery_id, effect_key FROM queue.effects WHERE workspace_id = ${workspaceId}`)
      .toEqual([{ message_id: first.messageId, origin_delivery_id: claimed.deliveryId, effect_key: effectKey }]);
    const auditResponse = await app.handle(new Request(`${baseUrl}/audit?limit=500`, { headers }));
    expect(auditResponse.status).toBe(200);
    const { events } = await auditResponse.json() as AuditPage;
    expect(events.filter((e) => e.kind === "effect.begin")).toEqual([expect.objectContaining({
      objects: [f.queue, first.messageId, claimed.deliveryId], principal_id: principalId, run_id: runId,
      user_id: null, row_count: "1", metadata: { attempt: 1, state: "begun" },
    })]);
    expect(events.find((e) => e.kind === "queue.ack")?.metadata).toEqual({ attempt: 1, state: "succeeded", effectOutcome: "applied" });
    const audit = JSON.stringify(events);
    for (const secret of [action, destination, effectKey, claimed.receipt]) expect(audit).not.toContain(secret);

    expect((await f.send("effect-key-attempt-two")).status).toBe(201);
    const unbegunResponse = await f.claim();
    expect(unbegunResponse.status).toBe(200);
    const unbegun = await unbegunResponse.json() as Claim;
    expect(unbegun.attempt).toBe(1);
    expect((await f.receipt(unbegun.deliveryId, unbegun.receipt, "nack")).status).toBe(200);
    await advanceDeliveryClock(admin, { workspaceId, principalId, runId }, unbegun.deliveryId, "scheduled");
    const retryResponse = await f.claim();
    expect(retryResponse.status).toBe(200);
    const retry = await retryResponse.json() as Claim;
    expect(retry.attempt).toBe(2);
    expect(retry.messageId).toBe(unbegun.messageId);
    expect(retry.deliveryId).not.toBe(unbegun.deliveryId);
    const retryBegin = await app.handle(new Request(`${baseUrl}/deliveries/${retry.deliveryId}/begin-effect`, {
      method: "POST", headers, body: JSON.stringify({ receipt: retry.receipt, action, destination }),
    }));
    expect(retryBegin.status).toBe(200);
    const retryEffect = await retryBegin.json() as BeginEffect;
    expect(retryEffect.effectKey).toBe(effectKey);
    expect(retryEffect.effectKey).toBe(effect.effectKey);
  } finally {
    await pool.close();
    await admin.close();
  }
});
