import { expect, test } from "bun:test";
import type { AuditPage } from "../events/read-audit-input.ts";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { advanceDeliveryClock, createRun, issueKey, recoveryFixture } from "../testing/session.ts";
import type { Claim } from "./claim-input.ts";
import type { DeliveryEnvelope } from "./delivery-envelope.ts";

test("revocation commits credentials without pausing begun Effects or admits a concurrent begin", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const f = await recoveryFixture(pool);
    const { app, workspaceId, principalId, runId, baseUrl, headers } = f;
    const post = (path: string, body: unknown, actorHeaders: Record<string, string> = headers) =>
      app.handle(new Request(`${baseUrl}${path}`, { method: "POST", headers: actorHeaders, body: JSON.stringify(body) }));
    const consumerResponse = await post("/principals", { name: "unrelated" }, f.userHeaders);
    expect(consumerResponse.status).toBe(201);
    const consumer = await consumerResponse.json() as { id: string };
    const otherKey = await issueKey(app, f.cookie, workspaceId, consumer.id);
    const otherRun = await createRun(app, otherKey, workspaceId);
    const otherHeaders = { ...headers, authorization: `Bearer ${otherKey}`, "x-backplane-run": otherRun };
    const begin = (delivery: Claim, actorHeaders = headers) => post(`/deliveries/${delivery.deliveryId}/begin-effect`, {
      receipt: delivery.receipt, action: `submit:${delivery.messageId}`, destination: "outside",
    }, actorHeaders);
    const begun: Claim[] = [];
    for (const key of ["pause-first", "pause-second"]) {
      expect((await f.send(key)).status).toBe(201);
      const response = await f.claim();
      expect(response.status).toBe(200);
      const delivery = await response.json() as Claim;
      expect((await begin(delivery)).status).toBe(200);
      begun.push(delivery);
    }
    expect((await f.send("unrelated")).status).toBe(201);
    const otherResponse = await post(`/queues/${f.queue}/claim`, {}, otherHeaders);
    expect(otherResponse.status).toBe(200);
    const unrelated = await otherResponse.json() as Claim;
    expect((await begin(unrelated, otherHeaders)).status).toBe(200);
    expect((await f.send("race")).status).toBe(201);
    const raceResponse = await f.claim();
    expect(raceResponse.status).toBe(200);
    const racing = await raceResponse.json() as Claim;
    await advanceDeliveryClock(admin, { workspaceId, principalId, runId }, begun[0]!.deliveryId, "leased");
    const before = await admin<{ id: string; effect_started_at: string }[]>`
      SELECT id, effect_started_at::text FROM queue.deliveries
      WHERE workspace_id = ${workspaceId} AND consumer_principal_id = ${principalId} AND state = 'begun' ORDER BY id`;
    const revoke = () => post(`/principals/${principalId}/revoke`, {}, f.userHeaders);
    // A real archive failure must roll back the preceding credential and Principal updates.
    await admin`REVOKE EXECUTE ON FUNCTION pgmq.archive(text,bigint) FROM bp_queue`;
    try {
      const failed = await revoke();
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ error: "principal_revocation_failed" });
      expect(await pool<{ status: string }[]>`SELECT status FROM control.principals
        WHERE workspace_id = ${workspaceId} AND id = ${principalId}`).toEqual([{ status: "active" }]);
      expect(await pool<{ revoked: boolean }[]>`SELECT revoked_at IS NOT NULL AS revoked FROM control.principal_keys
        WHERE workspace_id = ${workspaceId} AND principal_id = ${principalId}`).toEqual([{ revoked: false }]);
      expect(await admin<{ id: string }[]>`SELECT id FROM queue.deliveries
        WHERE workspace_id = ${workspaceId} AND state = 'effect-paused'`).toEqual([]);
      const response = await app.handle(new Request(`${baseUrl}/audit?limit=500`, { headers }));
      expect(response.status).toBe(200);
      expect((await response.json() as AuditPage).events.filter((e) =>
        e.kind === "principal.revoked" || e.kind === "effect.paused")).toEqual([]);
    } finally {
      await admin`GRANT EXECUTE ON FUNCTION pgmq.archive(text,bigint) TO bp_queue`;
    }
    const [raceBegin, revoked] = await Promise.all([begin(racing), revoke()]);
    expect(revoked.status).toBe(200);
    if (raceBegin.status === 200) {
      begun.push(racing);
    } else {
      expect([401, 403]).toContain(raceBegin.status);
      expect(["unauthorized", "principal_revoked"]).toContain((await raceBegin.json() as { error: string }).error);
    }
    const listing = await f.list("?state=effect-paused", f.userHeaders);
    expect(listing.status).toBe(200);
    const paused = (await listing.json() as { items: DeliveryEnvelope[] }).items;
    expect(paused.map((d) => d.id).sort()).toEqual(begun.map((d) => d.deliveryId).sort());
    for (const delivery of paused) expect(delivery).toMatchObject({
      state: "effect-paused", current: true, consumerPrincipalId: principalId, consumerRunId: runId,
      nextAttemptAt: null, completedAt: expect.any(String), effectStartedAt: expect.any(String), failureCode: "principal_revoked",
    });
    expect(await admin<{ id: string; effect_started_at: string }[]>`
      SELECT id, effect_started_at::text FROM queue.deliveries
      WHERE id = ANY(${admin.array(before.map((d) => d.id), "UUID")}) ORDER BY id`)
      .toEqual(before);
    expect(await admin<{ id: string }[]>`SELECT id FROM queue.deliveries
      WHERE workspace_id = ${workspaceId} AND consumer_principal_id = ${principalId}
        AND (state = 'begun' OR (state = 'effect-paused' AND receipt_token_hash IS NOT NULL))`).toEqual([]);
    expect(await pool<{ status: string }[]>`SELECT status FROM control.principals WHERE workspace_id = ${workspaceId} AND id = ${principalId}`)
      .toEqual([{ status: "revoked" }]);
    expect(await pool<{ revoked: boolean }[]>`SELECT revoked_at IS NOT NULL AS revoked FROM control.principal_keys
      WHERE workspace_id = ${workspaceId} AND principal_id = ${principalId}`).toEqual([{ revoked: true }]);
    const otherListing = await f.list("?state=begun", otherHeaders);
    expect(otherListing.status).toBe(200);
    expect((await otherListing.json() as { items: DeliveryEnvelope[] }).items).toEqual([expect.objectContaining({
      id: unrelated.deliveryId, consumerPrincipalId: consumer.id, consumerRunId: otherRun, state: "begun",
    })]);
    const audit = async () => {
      const response = await app.handle(new Request(`${baseUrl}/audit?limit=500`, { headers: f.userHeaders }));
      expect(response.status).toBe(200);
      return (await response.json() as AuditPage).events;
    };
    const events = await audit();
    const revocation = events.find((e) => e.kind === "principal.revoked" && e.objects.includes(principalId))!;
    expect(revocation.user_id).toBeString();
    const pauses = events.filter((e) => e.kind === "effect.paused");
    expect(pauses).toHaveLength(begun.length);
    expect(pauses.map((e) => e.objects[2])).toEqual(begun.map((d) => d.deliveryId).sort());
    for (const event of pauses) expect(event).toMatchObject({
      principal_id: null, run_id: null, user_id: revocation.user_id, row_count: "1",
      metadata: { attempt: 1, state: "effect-paused", reason: "principal_revoked" },
    });
    expect(events.slice(events.indexOf(revocation) + 1)).toEqual(pauses);
    expect((await revoke()).status).toBe(200);
    expect(await audit()).toEqual(events);
    expect((await begin(begun[0]!)).status).toBe(401);
    expect((await f.receipt(begun[0]!.deliveryId, begun[0]!.receipt, "ack")).status).toBe(401);
    expect((await f.replay(begun[0]!.deliveryId)).status).toBe(409);
    expect((await post(`/deliveries/${begun[0]!.deliveryId}/release`, {}, f.userHeaders)).status).toBe(409);
    expect((await f.cancel(begun[0]!.deliveryId, true)).status).toBe(409);
    const claim = await post(`/queues/${f.queue}/claim`, {}, otherHeaders);
    expect(claim.status).toBe(200);
    expect(await claim.json()).toBeNull();
  } finally {
    await pool.close();
    await admin.close();
  }
});
