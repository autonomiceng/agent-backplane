import { expect, test } from "bun:test";
import { approvalFixture } from "./testing/session.ts";
import type { ApprovalsPage } from "./list-approvals-input.ts";
import { createApprovalInbox } from "../../web/client/approval-inbox.ts";
import { renderApprovalInbox, renderApprovalRoute } from "../../web/testing/render-approval-inbox.tsx";

test("a stale or already-decided Approval appears successful in the inbox", async () => {
  const f = await approvalFixture();
  let client: ReturnType<typeof createApprovalInbox> | undefined;
  try {
    const staleClaim = await f.claimed("stale"), stale = await f.request(staleClaim);
    const decidedClaim = await f.claimed("decided"), decided = await f.request(decidedClaim);
    const freshClaim = await f.claimed("fresh"), fresh = await f.request(freshClaim);
    const fetcher: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init); request.headers.set("cookie", f.cookie);
      return f.app.handle(request);
    }, { preconnect: fetch.preconnect });
    client = createApprovalInbox("http://localhost", f.workspaceId, fetcher, 2);
    await client.refresh();
    expect(client.getSnapshot().error).toBeNull();
    expect(client.getSnapshot().items.map((item) => item.id)).toEqual([stale.id, decided.id]);
    expect(client.getSnapshot().items[0]).toMatchObject({ requestedBy: f.principalId, requestedRunId: f.runId,
      expired: false, target: { kind: "message", queue: f.queue, messageId: staleClaim.messageId, deliveryId: staleClaim.deliveryId } });
    const cursor = client.getSnapshot().nextCursor;
    expect(cursor).not.toBeNull();
    const listUrl = `${f.baseUrl}/approvals`;
    const principalPage = await f.app.handle(new Request(`${listUrl}?limit=2`, { headers: { authorization: f.headers.authorization } }));
    expect(principalPage.status).toBe(200);
    expect(principalPage.headers.get("cache-control")).toBe("no-store");
    expect((await principalPage.json() as ApprovalsPage).items).toEqual(client.getSnapshot().items);
    await client.next();
    expect(client.getSnapshot().items.map((item) => item.id)).toEqual([fresh.id]);
    expect(client.getSnapshot().nextCursor).toBeNull();
    await client.previous();
    expect((await f.call(`/deliveries/${staleClaim.deliveryId}/release`, {}, f.userHeaders)).status).toBe(201);
    expect((await f.decide(decided.id)).status).toBe(200);
    client.reason(stale.id, "reviewed");
    client.reason(decided.id, "reviewed");
    await Promise.all([client.decide(stale.id, "approve"), client.decide(decided.id, "approve")]);
    expect(client.getSnapshot().submissions[stale.id]).toMatchObject({ phase: "failed", status: 409, error: "approval_stale", result: null });
    expect(client.getSnapshot().submissions[decided.id]).toMatchObject({ phase: "failed", status: 409, error: "approval_decided", result: null });
    await client.refresh();
    expect(renderApprovalInbox(client)).toContain("failed: 409 approval_stale");
    expect(renderApprovalInbox(client)).toContain("failed: 409 approval_decided");
    expect(renderApprovalInbox(client)).not.toContain("200: approve");
    expect(client.getSnapshot().reasons[stale.id]).toBe("reviewed");
    expect(client.getSnapshot().items.some((item) => item.id === decided.id)).toBe(false);
    client.reason(fresh.id, "reviewed");
    await client.decide(fresh.id, "approve");
    const result = client.getSnapshot().submissions[fresh.id]?.result;
    expect(result).toMatchObject({ id: fresh.id, decision: "approve" });
    expect(result?.releasedDeliveryId).toBeString();
    const markup = renderApprovalInbox(client);
    expect(markup).toContain("200: approve");
    expect(markup).toContain(result?.releasedDeliveryId ?? "missing Delivery");
    expect(markup).toContain("failed: 409 approval_decided");
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
    const invalidLimit = await f.app.handle(new Request(`${listUrl}?limit=abc`, { headers: f.userHeaders }));
    expect(invalidLimit.status).toBe(422);
    expect(await invalidLimit.json()).toEqual({ error: "invalid_input" });
    const crossedCursor = await f.app.handle(new Request(`${listUrl}?state=decided&after=${cursor}`, { headers: f.userHeaders }));
    expect(crossedCursor.status).toBe(422);
    expect(await crossedCursor.json()).toEqual({ error: "invalid_input" });
    const noFallback = await f.app.handle(new Request(listUrl, { headers: { ...f.userHeaders, authorization: "broken" } }));
    expect(noFallback.status).toBe(401);
    const forbidden = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${crypto.randomUUID()}/approvals`, { headers: f.userHeaders }));
    expect(forbidden.status).toBe(403);
    const dashboard = await f.app.handle(new Request(`http://localhost/dashboard/workspaces/${f.workspaceId}/approvals`));
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("/dashboard/assets/");
    expect(renderApprovalRoute(f.workspaceId)).toContain("Loading Approvals");
  } finally { client?.dispose(); await f.close(); }
});
