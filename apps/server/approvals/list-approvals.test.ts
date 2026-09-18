import { expect, test } from "bun:test";
import { approvalFixture } from "./testing/session.ts";
import type { ApprovalsPage } from "./list-approvals-input.ts";
import type { decideResponse } from "./decide-input.ts";

test("stale decisions or cursor scope bypass Approval API checks", async () => {
  const f = await approvalFixture();
  try {
    const staleClaim = await f.claimed("stale"), stale = await f.request(staleClaim);
    const decidedClaim = await f.claimed("decided"), decided = await f.request(decidedClaim);
    const freshClaim = await f.claimed("fresh"), fresh = await f.request(freshClaim);
    const listUrl = `${f.baseUrl}/approvals`;
    const readPage = async (query = "?limit=2", headers: Record<string, string> = f.userHeaders) => {
      const response = await f.app.handle(new Request(`${listUrl}${query}`, { headers }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return await response.json() as ApprovalsPage;
    };
    const first = await readPage();
    expect(first.items.map(item => item.id)).toEqual([stale.id, decided.id]);
    expect(first.items[0]).toMatchObject({ requestedBy: f.principalId, requestedRunId: f.runId,
      expired: false, target: { kind: "message", queue: f.queue, messageId: staleClaim.messageId, deliveryId: staleClaim.deliveryId } });
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    if (cursor === null) throw new Error("Approval cursor missing");
    const principalPage = await readPage("?limit=2", { authorization: f.headers.authorization });
    expect(principalPage.items).toEqual(first.items);
    const next = await readPage(`?limit=2&after=${encodeURIComponent(cursor)}`);
    expect(next.items.map(item => item.id)).toEqual([fresh.id]);
    expect(next.nextCursor).toBeNull();
    expect((await readPage()).items).toEqual(first.items);

    expect((await f.call(`/deliveries/${staleClaim.deliveryId}/release`, {}, f.userHeaders)).status).toBe(201);
    expect((await f.decide(decided.id)).status).toBe(200);
    const [staleResponse, decidedResponse] = await Promise.all([
      f.decide(stale.id), f.decide(decided.id),
    ]);
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toEqual({ error: "approval_stale" });
    expect(decidedResponse.status).toBe(409);
    expect(await decidedResponse.json()).toEqual({ error: "approval_decided" });
    const refreshed = await readPage();
    expect(refreshed.items.map(item => item.id)).toEqual([stale.id, fresh.id]);
    const approved = await f.decide(fresh.id);
    expect(approved.status).toBe(200);
    const result = await approved.json() as typeof decideResponse.static;
    expect(result).toMatchObject({ id: fresh.id, decision: "approve" });
    expect(result.releasedDeliveryId).toBeString();
    const [user] = await f.pool<{ id: string }[]>`SELECT id FROM control."user"`;
    if (!user || !result?.releasedDeliveryId) throw new Error("Decision attribution or released Delivery missing");
    expect(await f.pool<{ id: string; user_id: string | null; principal_id: string | null; run_id: string | null }[]>`SELECT objects[1] AS id, user_id, principal_id, run_id FROM audit.events
      WHERE workspace_id = ${f.workspaceId} AND kind = 'approval.decide' ORDER BY position`).toEqual([
      { id: decided.id, user_id: user.id, principal_id: null, run_id: null },
      { id: fresh.id, user_id: user.id, principal_id: null, run_id: null },
    ]);
    expect(await f.admin<{ id: string }[]>`SELECT id FROM queue.deliveries WHERE parent_id = ${freshClaim.deliveryId}`).toEqual([{ id: result.releasedDeliveryId }]);
    expect(await f.admin<{ id: string }[]>`SELECT id FROM queue.deliveries WHERE parent_id = ${decidedClaim.deliveryId}`).toHaveLength(1);
    expect(await f.admin<{ id: string }[]>`SELECT id FROM queue.deliveries WHERE parent_id = ${staleClaim.deliveryId}`).toHaveLength(1);
    const decidedPage = await f.app.handle(new Request(`${listUrl}?state=decided`, { headers: f.userHeaders }));
    expect(decidedPage.status).toBe(200);
    expect((await decidedPage.json() as ApprovalsPage).items.map((item) => [item.id, item.decision])).toEqual([[decided.id, "approve"], [fresh.id, "approve"]]);
    const crossedCursor = await f.app.handle(new Request(`${listUrl}?state=decided&after=${cursor}`, { headers: f.userHeaders }));
    expect(crossedCursor.status).toBe(422);
    expect(await crossedCursor.json()).toEqual({ error: "invalid_input" });
    const noFallback = await f.app.handle(new Request(listUrl, { headers: { ...f.userHeaders, authorization: "broken" } }));
    expect(noFallback.status).toBe(401);
    const forbidden = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${crypto.randomUUID()}/approvals`, { headers: f.userHeaders }));
    expect(forbidden.status).toBe(403);
  } finally { await f.close(); }
});
