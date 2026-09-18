import { expect, test } from "bun:test";
import type { Claim } from "../queue/claim-input.ts";
import { createRun, signIn } from "../testing/session.ts";
import { approvalFixture, denied } from "./testing/session.ts";

test("unauthorized credentials or a requester changing Runs gain approval authority", async () => {
  const f = await approvalFixture();
  try {
    const original = await f.claimed("authority");
    const other = await f.consumer("Approver");
    const body = { deliveryId: original.deliveryId, receipt: original.receipt };
    await denied(await f.call("/approvals", body, other.headers), 403, "receipt_foreign");
    expect(await f.pool<{ id: string }[]>`SELECT id FROM control.approvals`).toEqual([]);
    expect(await f.admin<{ state: string }[]>`SELECT state FROM queue.deliveries WHERE id = ${original.deliveryId}`).toEqual([{ state: "leased" }]);
    const workspaceResponse = await f.app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: f.userHeaders, body: JSON.stringify({ name: "Other Workspace" }),
    }));
    expect(workspaceResponse.status).toBe(201);
    const workspace = await workspaceResponse.json() as { id: string };
    await denied(await f.call("/approvals", body, f.headers, "POST", workspace.id), 403, "workspace_forbidden");
    const approval = await f.request(original);
    await denied(await f.call(`/approvals/${approval.id}/decision`, { decision: "approve", reason: "reviewed" }, other.headers, "POST", workspace.id), 403, "workspace_forbidden");
    await denied(await f.call(`/approvals/${approval.id}/decision`, { decision: "approve", reason: "reviewed" }, f.userHeaders, "POST", workspace.id), 404, "approval_not_found");
    await denied(await f.decide(approval.id, other.headers), 403, "approval_forbidden");
    await denied(await f.decide(approval.id, { ...f.userHeaders, authorization: "Bearer invalid" }), 401, "unauthorized");
    await denied(await f.decide(approval.id, { ...f.userHeaders, authorization: "" }), 401, "unauthorized");
    await denied(await f.call("/approvals/settings", { allowSelfApproval: true }, f.headers, "PUT"), 403, "approval_forbidden");
    await denied(await f.call(`/approvals/delegations/${other.id}`, { enabled: true }, { ...f.headers, ...f.userHeaders }, "PUT"), 403, "approval_forbidden");
    await denied(await f.decide(approval.id, { ...f.userHeaders, origin: "https://evil.example" }), 403, "origin_forbidden");
    const malformed = await f.app.handle(new Request(`${f.baseUrl}/approvals/${approval.id}/decision`, {
      method: "POST", headers: f.userHeaders, body: "{",
    }));
    await denied(malformed, 400, "invalid_json");
    await denied(await f.call(`/approvals/${approval.id}/decision`, { decision: "approve", reason: "free text" }, f.userHeaders), 422, "invalid_input");
    await denied(await f.call(`/approvals/${approval.id}/decision`, { decision: "approve", reason: "reviewed", extra: true }, f.userHeaders), 422, "invalid_input");
    expect((await f.delegate(other.id)).status).toBe(200);
    expect((await f.delegate(other.id, false)).status).toBe(200);
    await denied(await f.decide(approval.id, other.headers), 403, "approval_forbidden");

    // Identity membership is outside the Workspace ledger; preserve the User while replacing membership.
    const grantorCookie = await signIn(f.app);
    const grantorHeaders = { ...f.userHeaders, cookie: grantorCookie };
    expect((await f.call(`/approvals/delegations/${other.id}`, { enabled: true }, grantorHeaders, "PUT")).status).toBe(200);
    const [grantor] = await f.admin<{ id: string; userId: string; organizationId: string; role: string }[]>`
      SELECT m.id, m."userId", m."organizationId", m.role FROM control.member m JOIN control."user" u ON u.id = m."userId"
      WHERE u.email = 'credentials@example.com'`;
    if (!grantor) throw new Error("Grantor membership missing");
    await f.admin`DELETE FROM control.member WHERE id = ${grantor.id}`;
    await denied(await f.decide(approval.id, other.headers), 403, "approval_forbidden");
    await denied(await f.decide(approval.id, grantorHeaders), 403, "workspace_forbidden");
    await f.admin`INSERT INTO control.member (id, "userId", "organizationId", role, "createdAt")
      VALUES (${crypto.randomUUID()}, ${grantor.userId}, ${grantor.organizationId}, ${grantor.role}, clock_timestamp())`;
    await denied(await f.decide(approval.id, other.headers), 403, "approval_forbidden");

    expect((await f.delegate(f.principalId)).status).toBe(200);
    const anotherRun = await createRun(f.app, f.key, f.workspaceId);
    const selfHeaders = { ...f.headers, "x-backplane-run": anotherRun };
    await denied(await f.decide(approval.id, selfHeaders), 403, "approval_self_forbidden");
    expect(await f.pool<{ decision: string | null }[]>`SELECT decision FROM control.approvals WHERE id = ${approval.id}`).toEqual([{ decision: null }]);
    expect(await f.pool<{ position: bigint }[]>`SELECT position FROM audit.events WHERE kind = 'approval.decide'`).toEqual([]);
    expect(await f.admin<{ id: string }[]>`SELECT id FROM queue.deliveries WHERE parent_id = ${original.deliveryId}`).toEqual([]);
    expect((await f.call("/approvals/settings", { allowSelfApproval: true }, f.userHeaders, "PUT")).status).toBe(200);
    expect((await f.call("/approvals/settings", { allowSelfApproval: true }, f.userHeaders, "PUT")).status).toBe(200);
    expect((await f.decide(approval.id, selfHeaders)).status).toBe(200);
    const [decision] = await f.pool<{ principal_id: string; run_id: string; metadata: string }[]>`
      SELECT principal_id, run_id, metadata::text FROM audit.events WHERE kind = 'approval.decide'`;
    expect(decision).toMatchObject({ principal_id: f.principalId, run_id: anotherRun });
    expect(JSON.parse(decision?.metadata ?? "null")).toMatchObject({ allowSelfApproval: true });
    expect(await f.pool<{ user_id: string | null }[]>`SELECT user_id FROM audit.events WHERE kind = 'approval.settings'`).toHaveLength(1);
    expect((await f.call("/approvals/settings", { allowSelfApproval: false }, f.userHeaders, "PUT")).status).toBe(200);
    const successor = await f.claim();
    const heldAgain = await f.request(await successor.json() as Claim);
    await denied(await f.decide(heldAgain.id, selfHeaders), 403, "approval_self_forbidden");
  } finally { await f.close(); }
});
