import { expect, test } from "bun:test";
import type { Claim } from "../queue/claim-input.ts";
import type { DeliveryEnvelope } from "../queue/delivery-envelope.ts";
import { approvalFixture, denied } from "./testing/session.ts";

test("an expired Approval or a superseded held version releases another Delivery", async () => {
  const f = await approvalFixture();
  try {
    const original = await f.claimed("expires");
    const expired = await f.request(original, 1);
    for (;;) {
      const [clock] = await f.pool<{ passed: boolean }[]>`SELECT clock_timestamp() >= expires_at AS passed
        FROM control.approvals WHERE id = ${expired.id}`;
      if (clock?.passed) break;
      await Bun.sleep(20);
    }
    await denied(await f.decide(expired.id), 409, "approval_expired");
    const second = await f.claimed("superseded");
    const stale = await f.request(second);
    const release = await f.call(`/deliveries/${second.deliveryId}/release`, {}, f.userHeaders);
    expect(release.status).toBe(201);
    const successor = await release.json() as DeliveryEnvelope;
    const claimResponse = await f.claim();
    expect(claimResponse.status).toBe(200);
    const reclaimed = await claimResponse.json() as Claim;
    expect(reclaimed.deliveryId).toBe(successor.id);
    const current = await f.request(reclaimed);
    expect(current.targetVersion).not.toBe(stale.targetVersion);
    await denied(await f.decide(stale.id), 409, "approval_stale");
    expect(await f.admin<{ id: string; current: boolean; state: string }[]>`SELECT id, current, state FROM queue.deliveries WHERE message_id = ${second.messageId} ORDER BY created_at, id`)
      .toEqual([{ id: second.deliveryId, current: false, state: "held" }, { id: successor.id, current: true, state: "held" }]);
    expect(await f.admin<{ id: string }[]>`SELECT id FROM queue.deliveries WHERE parent_id = ${original.deliveryId}`).toEqual([]);
    expect(await f.pool<{ position: bigint }[]>`SELECT position FROM audit.events WHERE kind = 'approval.decide'`).toEqual([]);
    expect(await f.pool<{ decision: string | null }[]>`SELECT decision FROM control.approvals WHERE workspace_id = ${f.workspaceId}`)
      .toEqual([{ decision: null }, { decision: null }, { decision: null }]);
    expect(await f.pool<{ reason: string }[]>`SELECT reason FROM audit.rejections WHERE kind = 'approval.decide' ORDER BY id`)
      .toEqual([{ reason: "approval_expired" }, { reason: "approval_stale" }]);
    expect(await (await f.claim()).json()).toBeNull();
  } finally { await f.close(); }
});

test("concurrent approval releases twice or revives the old Receipt with incorrect decision attribution", async () => {
  const f = await approvalFixture();
  try {
    const original = await f.claimed("once");
    const approval = await f.request(original);
    const [held] = await f.admin<{ chain_id: string; version: string }[]>`SELECT chain_id, to_jsonb(d)->>'held_at' AS version
      FROM queue.deliveries d WHERE id = ${original.deliveryId}`;
    expect(approval).toMatchObject({ targetKind: "message", targetId: original.deliveryId, targetVersion: held?.version });
    expect(await (await f.claim()).json()).toBeNull();
    const responses = await Promise.all([f.decide(approval.id), f.decide(approval.id)]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const success = responses.find((r) => r.status === 200);
    const conflict = responses.find((r) => r.status === 409);
    if (!success || !conflict) throw new Error("Concurrent decision responses missing");
    await denied(conflict, 409, "approval_decided");
    expect(success.headers.get("cache-control")).toBe("no-store");
    const result = await success.json() as { id: string; decision: string; releasedDeliveryId: string };
    expect(result).toMatchObject({ id: approval.id, decision: "approve" });
    expect(result.releasedDeliveryId).not.toBe(original.deliveryId);
    expect(await f.admin<{ id: string; attempt: number; state: string; parent_id: string; current: boolean }[]>`SELECT id, attempt, state, parent_id, current FROM queue.deliveries WHERE parent_id = ${original.deliveryId}`)
      .toEqual([{ id: result.releasedDeliveryId, attempt: 1, state: "ready", parent_id: original.deliveryId, current: true }]);
    const [fresh] = await f.admin<{ chain_id: string }[]>`SELECT chain_id FROM queue.deliveries WHERE id = ${result.releasedDeliveryId}`;
    expect(fresh?.chain_id).not.toBe(held?.chain_id);
    const claimedResponse = await f.claim();
    expect(claimedResponse.status).toBe(200);
    const claimed = await claimedResponse.json() as Claim;
    expect(claimed).toMatchObject({ deliveryId: result.releasedDeliveryId, messageId: original.messageId, attempt: 1 });
    expect(claimed.receipt).not.toBe(original.receipt);
    for (const id of [original.deliveryId, claimed.deliveryId]) {
      for (const verb of ["ack", "nack", "renew", "hold"]) {
        await denied(await f.receipt(id, original.receipt, verb), 409, "receipt_stale");
      }
    }
    expect(await f.admin<{ id: string; current: boolean; state: string }[]>`SELECT id, state, current FROM queue.deliveries WHERE message_id = ${original.messageId} ORDER BY created_at, id`)
      .toEqual([{ id: original.deliveryId, state: "held", current: false }, { id: claimed.deliveryId, state: "leased", current: true }]);
    expect((await f.receipt(claimed.deliveryId, claimed.receipt, "ack")).status).toBe(200);
    const other = await f.consumer("Delegated Approver");
    expect((await f.delegate(other.id)).status).toBe(200);
    expect((await f.delegate(other.id)).status).toBe(200);
    const delegatedClaim = await f.claimed("delegated");
    const delegated = await f.request(delegatedClaim);
    const delegatedResponse = await f.decide(delegated.id, other.headers);
    expect(delegatedResponse.status).toBe(200);
    const delegatedResult = await delegatedResponse.json() as { releasedDeliveryId: string };
    const delegatedFresh = await (await f.claim()).json() as Claim;
    expect(delegatedFresh.deliveryId).toBe(delegatedResult.releasedDeliveryId);
    expect((await f.receipt(delegatedFresh.deliveryId, delegatedFresh.receipt, "ack")).status).toBe(200);
    const rejectedClaim = await f.claimed("reject");
    const rejected = await f.request(rejectedClaim);
    const rejectedResponse = await f.decide(rejected.id, other.headers, "reject");
    expect(rejectedResponse.status).toBe(200);
    expect(await rejectedResponse.json()).toEqual({ id: rejected.id, decision: "reject", releasedDeliveryId: null });
    expect(await f.admin<{ state: string; current: boolean }[]>`SELECT state, current FROM queue.deliveries WHERE id = ${rejectedClaim.deliveryId}`)
      .toEqual([{ state: "held", current: true }]);
    expect(await f.admin<{ id: string }[]>`SELECT id FROM queue.deliveries WHERE parent_id = ${rejectedClaim.deliveryId}`).toEqual([]);
    expect(await (await f.claim()).json()).toBeNull();
    await denied(await f.decide(rejected.id), 409, "approval_decided");

    const [user] = await f.pool<{ id: string }[]>`SELECT id FROM control."user" WHERE email = 'credentials@example.com'`;
    const [member] = await f.pool<{ id: string }[]>`SELECT id FROM control.member WHERE "userId" = ${user?.id ?? ""}`;
    if (!user || !member) throw new Error("User membership missing");
    const events = await f.pool<{ kind: string; principal_id: string | null; run_id: string | null; user_id: string | null;
      objects: string[]; row_count: bigint; metadata: string }[]>`
      SELECT kind, principal_id, run_id, user_id, objects, row_count, metadata::text FROM audit.events
      WHERE workspace_id = ${f.workspaceId} AND (kind LIKE 'approval.%' OR kind IN ('queue.hold', 'queue.release')) ORDER BY position`;
    const normalized = events.map((event) => ({ ...event, row_count: Number(event.row_count), metadata: JSON.parse(event.metadata) }));
    const userActor = { principal_id: null, run_id: null, user_id: user.id, row_count: 1 };
    const requester = { principal_id: f.principalId, run_id: f.runId, user_id: null, row_count: 1 };
    const delegateActor = { principal_id: other.id, run_id: other.runId, user_id: null, row_count: 1 };
    const requestEvents = (a: typeof approval, c: Claim) => [
      { ...requester, kind: "queue.hold", objects: [f.queue, c.messageId, c.deliveryId], metadata: { attempt: 1, state: "held" } },
      { ...requester, kind: "approval.request", objects: [a.id, c.deliveryId], metadata: { targetKind: "message", targetVersion: a.targetVersion, expiresAt: a.expiresAt } },
    ];
    const decisionMetadata = (version: string, releasedDeliveryId: string | null, delegatedByUserId: string | null) => ({
      targetKind: "message", targetVersion: version, decision: releasedDeliveryId ? "approve" : "reject",
      reason: "reviewed", releasedDeliveryId, allowSelfApproval: false, delegatedByUserId,
    });
    expect(normalized).toEqual([
      ...requestEvents(approval, original),
      { ...userActor, kind: "queue.release", objects: [f.queue, original.messageId, claimed.deliveryId], metadata: { attempt: 1, state: "ready" } },
      { ...userActor, kind: "approval.decide", objects: [approval.id, original.deliveryId], metadata: decisionMetadata(approval.targetVersion, claimed.deliveryId, null) },
      { ...userActor, kind: "approval.delegation", objects: [other.id], metadata: { enabled: true, memberId: member?.id } },
      ...requestEvents(delegated, delegatedClaim),
      { ...delegateActor, kind: "queue.release", objects: [f.queue, delegatedClaim.messageId, delegatedFresh.deliveryId], metadata: { attempt: 1, state: "ready" } },
      { ...delegateActor, kind: "approval.decide", objects: [delegated.id, delegatedClaim.deliveryId], metadata: decisionMetadata(delegated.targetVersion, delegatedFresh.deliveryId, user?.id ?? null) },
      ...requestEvents(rejected, rejectedClaim),
      { ...delegateActor, kind: "approval.decide", objects: [rejected.id, rejectedClaim.deliveryId], metadata: decisionMetadata(rejected.targetVersion, null, user?.id ?? null) },
    ]);
    expect(await f.pool`SELECT a.id FROM control.approvals a JOIN audit.events e ON e.workspace_id = a.workspace_id AND e.position = a.decision_position
      WHERE e.kind = 'approval.decide' AND e.objects[1] = a.id::text`).toHaveLength(3);
  } finally { await f.close(); }
});
