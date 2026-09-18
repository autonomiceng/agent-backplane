import { expect, test } from "bun:test";
import type { AuditPage } from "../events/read-audit-input.ts";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { advanceDeliveryClock, createRun, issueKey, recoveryFixture } from "../testing/session.ts";
import type { Claim } from "./claim-input.ts";
import type { BeginEffect } from "./begin-effect-input.ts";
import type { reconcileResponse } from "./reconcile-input.ts";

type Decision = typeof reconcileResponse.static;
async function fixture() {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const f = await recoveryFixture(pool);
    const call = (path: string, body: unknown, headers: Record<string, string> = f.headers, method: "POST" | "PUT" = "POST", workspaceId = f.workspaceId) =>
      f.app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}${path}`, { method, headers, body: JSON.stringify(body) }));
    const begin = (c: Claim, action = "submit", headers = f.headers) =>
      call(`/deliveries/${c.deliveryId}/begin-effect`, { receipt: c.receipt, action, destination: "private@example.com" }, headers);
    const started = async (key: string) => {
      expect((await f.send(key)).status).toBe(201);
      const response = await f.claim();
      expect(response.status).toBe(200);
      const claim = await response.json() as Claim;
      expect(claim).not.toBeNull();
      const begun = await begin(claim);
      expect(begun.status).toBe(200);
      return { claim, effect: await begun.json() as BeginEffect };
    };
    const ambiguous = async (key: string) => {
      const result = await started(key);
      await advanceDeliveryClock(admin, f, result.claim.deliveryId, "leased");
      const scan = await f.claim();
      expect(scan.status).toBe(200);
      expect(await scan.json()).toBeNull();
      return result;
    };
    const decide = (deliveryId: string, outcome: Decision["outcome"], headers: Record<string, string> = f.userHeaders, evidence = "private reconciliation evidence") =>
      call("/reconciliations", { deliveryId, outcome, evidence }, headers);
    const delegate = (id: string, enabled = true, headers: Record<string, string> = f.userHeaders) =>
      call(`/reconciliations/delegations/${id}`, { enabled }, headers, "PUT");
    const consumer = async (name: string) => {
      const response = await call("/principals", { name }, f.userHeaders);
      expect(response.status).toBe(201);
      const { id } = await response.json() as { id: string };
      const key = await issueKey(f.app, f.cookie, f.workspaceId, id);
      const runId = await createRun(f.app, key, f.workspaceId);
      return { id, runId, headers: { ...f.headers, authorization: `Bearer ${key}`, "x-backplane-run": runId } };
    };
    const audit = async () => {
      const response = await f.app.handle(new Request(`${f.baseUrl}/audit?limit=500`, { headers: f.userHeaders }));
      expect(response.status).toBe(200);
      return (await response.json() as AuditPage).events;
    };
    return { ...f, pool, admin, call, begin, started, ambiguous, decide, delegate, consumer, audit,
      close: async () => { await pool.close(); await admin.close(); } };
  } catch (error) { await pool.close(); await admin.close(); throw error; }
}
async function denied(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
}

test("consumer credentials bypass reconciliation delegation", async () => {
  const f = await fixture();
  try {
    const { claim } = await f.ambiguous("authorization");
    await denied(await f.decide(claim.deliveryId, "unknown", { authorization: `Bearer ${claim.receipt}`, "content-type": "application/json" }), 401, "unauthorized");
    await denied(await f.decide(claim.deliveryId, "unknown", f.headers), 403, "reconciliation_forbidden");
    await denied(await f.decide(claim.deliveryId, "unknown", { ...f.headers, cookie: f.cookie }), 403, "reconciliation_forbidden");
    await denied(await f.decide(claim.deliveryId, "unknown", { ...f.userHeaders, authorization: "malformed" }), 401, "unauthorized");
    await denied(await f.delegate(f.principalId, true, { ...f.headers, cookie: f.cookie }), 403, "reconciliation_forbidden");
    const workspace = await f.app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: f.userHeaders, body: JSON.stringify({ name: "Foreign" }),
    }));
    expect(workspace.status).toBe(201);
    const foreign = await workspace.json() as { id: string };
    const body = { deliveryId: claim.deliveryId, outcome: "unknown", evidence: "foreign" };
    await denied(await f.call("/reconciliations", body, f.headers, "POST", foreign.id), 403, "workspace_forbidden");
    await denied(await f.call("/reconciliations", body, f.userHeaders, "POST", foreign.id), 404, "delivery_not_found");
    expect(await f.admin`SELECT id FROM control.reconciliations`).toHaveLength(0);
    const decider = await f.consumer("Reconciler");
    expect((await f.delegate(decider.id)).status).toBe(200);
    expect((await f.delegate(decider.id, false)).status).toBe(200);
    await denied(await f.decide(claim.deliveryId, "unknown", decider.headers), 403, "reconciliation_forbidden");
    expect((await f.delegate(decider.id)).status).toBe(200);
    const unknown = await f.decide(claim.deliveryId, "unknown", decider.headers);
    expect(unknown.status).toBe(200);
    const delegated = await unknown.json() as Decision;
    const applied = await f.decide(claim.deliveryId, "applied");
    expect(applied.status).toBe(200);
    expect(applied.headers.get("cache-control")).toBe("no-store");
    const userDecision = await applied.json() as Decision;
    const [user] = await f.pool<{ id: string }[]>`SELECT id FROM control."user" WHERE email='credentials@example.com'`;
    if (!user) throw new Error("User missing");
    expect((await f.audit()).filter((e) => e.kind === "effect.reconciled")).toEqual([
      expect.objectContaining({ position: delegated.decisionPosition, objects: [f.queue, claim.messageId, claim.deliveryId, delegated.id],
        principal_id: decider.id, run_id: decider.runId, user_id: null }),
      expect.objectContaining({ position: userDecision.decisionPosition, principal_id: null, run_id: null, user_id: user.id }),
    ]);
    expect(await f.admin<{ consumer_principal_id: string; consumer_run_id: string }[]>`SELECT consumer_principal_id,consumer_run_id FROM queue.deliveries WHERE id=${claim.deliveryId}`)
      .toEqual([{ consumer_principal_id: f.principalId, consumer_run_id: f.runId }]);
    expect(await f.admin<{ principal_id: string | null; run_id: string | null; user_id: string | null }[]>`SELECT principal_id,run_id,user_id FROM control.reconciliations ORDER BY created_at`)
      .toEqual([{ principal_id: decider.id, run_id: decider.runId, user_id: null }, { principal_id: null, run_id: null, user_id: user.id }]);
  } finally { await f.close(); }
});

test("unknown reconciliation redispatches unresolved work", async () => {
  const f = await fixture();
  try {
    const { claim: ambiguous } = await f.ambiguous("unknown");
    const { claim: paused } = await f.started("paused");
    const worker = await f.consumer("Unrevoked consumer");
    expect((await f.call(`/principals/${f.principalId}/revoke`, {}, f.userHeaders)).status).toBe(200);
    const before = await f.admin<{ id: string; state: string; snapshot: string }[]>`SELECT id,state,to_jsonb(d)::text AS snapshot FROM queue.deliveries d ORDER BY id`;
    expect(before.map((d) => d.state).sort()).toEqual(["ambiguous", "effect-paused"]);
    const effects = await f.admin<{ snapshot: string }[]>`SELECT to_jsonb(e)::text AS snapshot FROM queue.effects e ORDER BY message_id`;
    await denied(await f.decide(ambiguous.deliveryId, "unknown", f.userHeaders, "é".repeat(2049)), 422, "invalid_input");
    await denied(await f.decide(ambiguous.deliveryId, "unknown", f.userHeaders, "a\0b"), 422, "invalid_input");
    await denied(await f.decide(ambiguous.deliveryId, "unknown", f.userHeaders, ""), 422, "invalid_input");
    await denied(await f.call("/reconciliations", { deliveryId: ambiguous.deliveryId, outcome: "unknown", evidence: "private", receipt: ambiguous.receipt }, f.userHeaders), 422, "invalid_input");
    const unknown = await f.decide(ambiguous.deliveryId, "unknown");
    expect(unknown.status).toBe(200);
    const decision = await unknown.json() as Decision;
    expect(decision).toMatchObject({ deliveryId: ambiguous.deliveryId, outcome: "unknown", successorDeliveryId: null });
    const pausedDecision = await f.decide(paused.deliveryId, "unknown");
    expect(pausedDecision.status).toBe(200);
    const beforeRepeat = await f.audit();
    const repeated = await f.decide(ambiguous.deliveryId, "unknown", f.userHeaders, "replacement evidence");
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(decision);
    expect(await f.audit()).toEqual(beforeRepeat);
    expect(await f.admin<{ id: string; state: string; snapshot: string }[]>`SELECT id,state,to_jsonb(d)::text AS snapshot FROM queue.deliveries d ORDER BY id`).toEqual(before);
    expect(await f.admin<{ snapshot: string }[]>`SELECT to_jsonb(e)::text AS snapshot FROM queue.effects e ORDER BY message_id`).toEqual(effects);
    const claim = await f.call(`/queues/${f.queue}/claim`, {}, worker.headers);
    expect(claim.status).toBe(200);
    expect(await claim.json()).toBeNull();
    expect(await (await f.call(`/queues/${f.queue}/claim`, {}, worker.headers)).json()).toBeNull();
    await denied(await f.replay(ambiguous.deliveryId), 409, "delivery_conflict");
    await denied(await f.cancel(paused.deliveryId, true), 409, "delivery_conflict");
    await denied(await f.call(`/deliveries/${ambiguous.deliveryId}/release`, {}, f.userHeaders), 409, "delivery_conflict");
    const recover = await f.call(`/queues/${f.queue}/recover`, {}, worker.headers);
    expect(recover.status).toBe(200);
    expect(await recover.json()).toEqual({ created: 0, hasMore: false });
    const definitive = await f.decide(ambiguous.deliveryId, "applied", f.userHeaders, "definitive private evidence");
    expect(definitive.status).toBe(200);
    expect((await f.decide(paused.deliveryId, "not_applied")).status).toBe(200);
    const historical = await f.decide(ambiguous.deliveryId, "unknown");
    expect(historical.status).toBe(200);
    expect(await historical.json()).toEqual(decision);
    expect(await f.admin<{ evidence: string }[]>`SELECT evidence FROM control.reconciliations WHERE id=${decision.id}`)
      .toEqual([{ evidence: "private reconciliation evidence" }]);
    const audit = JSON.stringify(await f.audit());
    expect(audit).not.toContain("private reconciliation evidence");
    expect(audit).not.toContain("definitive private evidence");
    expect(audit).not.toContain("replacement evidence");
    expect(audit).not.toContain("private@example.com");
    expect(audit).not.toContain(ambiguous.receipt);
  } finally { await f.close(); }
});

test("definitive reconciliation selects the wrong transition or resets twice", async () => {
  const f = await fixture();
  try {
    const applied = await f.ambiguous("applied");
    const appliedResponse = await f.decide(applied.claim.deliveryId, "applied");
    expect(appliedResponse.status).toBe(200);
    const appliedDecision = await appliedResponse.json() as Decision;
    expect(appliedDecision).toMatchObject({ deliveryId: applied.claim.deliveryId, outcome: "applied", successorDeliveryId: null });
    expect(await f.admin<{ state: string; current: boolean; failure_code: string | null; completed: boolean }[]>`SELECT state,current,failure_code,completed_at IS NOT NULL AS completed FROM queue.deliveries WHERE id=${applied.claim.deliveryId}`)
      .toEqual([{ state: "succeeded", current: true, failure_code: null, completed: true }]);
    expect(await (await f.claim()).json()).toBeNull();
    expect(await f.admin`SELECT id FROM queue.deliveries WHERE parent_id=${applied.claim.deliveryId}`).toHaveLength(0);
    await denied(await f.decide(applied.claim.deliveryId, "unknown"), 409, "reconciliation_conflict");
    const original = await f.ambiguous("not-applied");
    const [before] = await f.admin<{ chain_id: string; effect_started_at: Date }[]>`SELECT chain_id,effect_started_at FROM queue.deliveries WHERE id=${original.claim.deliveryId}`;
    if (!before) throw new Error("Predecessor missing");
    const responses = await Promise.all([f.decide(original.claim.deliveryId, "not_applied"), f.decide(original.claim.deliveryId, "not_applied")]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const decisions = await Promise.all(responses.map(async (r) => await r.json() as Decision));
    expect(decisions[0]).toEqual(decisions[1]);
    const decision = decisions[0];
    if (!decision) throw new Error("Decision missing");
    expect(decision.successorDeliveryId).not.toBeNull();
    if (!decision.successorDeliveryId) throw new Error("Successor missing");
    await denied(await f.decide(original.claim.deliveryId, "applied"), 409, "reconciliation_conflict");
    expect(await f.admin<{ state: string; current: boolean; failure_code: string | null; effect_started_at: Date }[]>`SELECT state,current,failure_code,effect_started_at FROM queue.deliveries WHERE id=${original.claim.deliveryId}`)
      .toEqual([{ state: "cancelled", current: false, failure_code: "reconciled_not_applied", effect_started_at: before.effect_started_at }]);
    const successors = await f.admin<{ id: string; parent_id: string; message_id: string; chain_id: string; attempt: number; max_attempts: number; state: string }[]>`SELECT id,parent_id,message_id,chain_id,attempt,max_attempts,state FROM queue.deliveries WHERE parent_id=${original.claim.deliveryId}`;
    expect(successors).toEqual([{ id: decision.successorDeliveryId, parent_id: original.claim.deliveryId, message_id: original.claim.messageId,
      chain_id: expect.any(String), attempt: 1, max_attempts: 5, state: "ready" }]);
    expect(successors[0]?.chain_id).not.toBe(before?.chain_id);
    expect(await f.admin<{ effect_key: string; origin_delivery_id: string; reset: boolean }[]>`SELECT effect_key,origin_delivery_id,reset FROM queue.effects WHERE message_id=${original.claim.messageId}`)
      .toEqual([{ effect_key: original.effect.effectKey, origin_delivery_id: original.claim.deliveryId, reset: true }]);
    const successor = await (await f.claim()).json() as Claim;
    expect(successor).toMatchObject({ deliveryId: decision.successorDeliveryId, messageId: original.claim.messageId, attempt: 1 });
    await denied(await f.receipt(original.claim.deliveryId, original.claim.receipt, "ack"), 409, "receipt_stale");
    await denied(await f.receipt(successor.deliveryId, original.claim.receipt, "ack"), 409, "receipt_stale");
    await denied(await f.begin(successor, "changed"), 409, "effect_key_conflict");
    expect((await f.receipt(successor.deliveryId, successor.receipt, "nack")).status).toBe(200);
    await advanceDeliveryClock(f.admin, f, successor.deliveryId, "scheduled");
    const retry = await (await f.claim()).json() as Claim;
    expect(retry).toMatchObject({ messageId: successor.messageId, attempt: 2 });
    const begun = await f.begin(retry);
    expect(begun.status).toBe(200);
    const effect = await begun.json() as BeginEffect;
    expect(effect.effectKey).toBe(original.effect.effectKey);
    const replay = await f.decide(original.claim.deliveryId, "not_applied");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(decision);
    expect(await f.admin<{ effect_key: string; origin_delivery_id: string; reset: boolean }[]>`SELECT effect_key,origin_delivery_id,reset FROM queue.effects WHERE message_id=${original.claim.messageId}`)
      .toEqual([{ effect_key: effect.effectKey, origin_delivery_id: original.claim.deliveryId, reset: false }]);
    const repeatBegin = await f.begin(retry);
    expect(repeatBegin.status).toBe(200);
    expect(await repeatBegin.json()).toEqual(effect);
    const events = await f.audit();
    expect(events.filter((e) => e.kind === "effect.begin" && e.objects.includes(retry.deliveryId))).toHaveLength(1);
    expect(events.filter((e) => e.kind === "effect.reconciled")).toEqual([
      expect.objectContaining({ position: appliedDecision.decisionPosition, metadata: { outcome: "applied", effectOutcome: "applied", successorDeliveryId: null } }),
      expect.objectContaining({ position: decision.decisionPosition, metadata: { outcome: "not_applied", effectOutcome: "not_applied", successorDeliveryId: successor.deliveryId } }),
    ]);
    expect(await f.admin`SELECT id FROM queue.deliveries WHERE parent_id=${original.claim.deliveryId}`).toHaveLength(1);
    expect(await f.admin`SELECT r.id FROM control.reconciliations r JOIN audit.events e ON e.workspace_id=r.workspace_id AND e.position=r.decision_position
      WHERE e.kind='effect.reconciled' AND e.objects[4]=r.id::text`).toHaveLength(2);
  } finally { await f.close(); }
});
