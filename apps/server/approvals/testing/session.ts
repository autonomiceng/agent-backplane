// Approval scenarios provision their actors and held work exclusively through HTTP.
import { expect } from "bun:test";
import { createPool } from "../../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../../testing/postgres.ts";
import { createRun, issueKey, recoveryFixture } from "../../testing/session.ts";
import type { Claim } from "../../queue/claim-input.ts";
import type { requestResponse } from "../request-input.ts";

export async function approvalFixture() {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const fixture = await recoveryFixture(pool);
    const { app, workspaceId, baseUrl, userHeaders, cookie, headers } = fixture;
    const call = (path: string, body: unknown, actorHeaders: Record<string, string> = headers, method: "POST" | "PUT" = "POST", workspace = workspaceId) =>
      app.handle(new Request(`http://localhost/api/v1/workspaces/${workspace}${path}`, { method, headers: actorHeaders, body: JSON.stringify(body) }));
    const delegate = (principalId: string, enabled = true) => call(`/approvals/delegations/${principalId}`, { enabled }, userHeaders, "PUT");
    const decide = (id: string, actorHeaders: Record<string, string> = userHeaders, decision = "approve") =>
      call(`/approvals/${id}/decision`, { decision, reason: "reviewed" }, actorHeaders);
    const consumer = async (name: string) => {
      const response = await app.handle(new Request(`${baseUrl}/principals`, { method: "POST", headers: userHeaders, body: JSON.stringify({ name }) }));
      expect(response.status).toBe(201);
      const { id } = await response.json() as { id: string };
      const key = await issueKey(app, cookie, workspaceId, id);
      const runId = await createRun(app, key, workspaceId);
      return { id, runId, headers: { ...headers, authorization: `Bearer ${key}`, "x-backplane-run": runId } };
    };
    const request = async (claim: Claim, expiresInSeconds = 3600) => {
      const response = await call("/approvals", { deliveryId: claim.deliveryId, receipt: claim.receipt, expiresInSeconds });
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return await response.json() as typeof requestResponse.static;
    };
    const claimed = async (key: string) => {
      expect((await fixture.send(key)).status).toBe(201);
      const response = await fixture.claim();
      expect(response.status).toBe(200);
      const claim = await response.json() as Claim;
      expect(claim).not.toBeNull();
      return claim;
    };
    return { ...fixture, pool, admin, call, delegate, decide, consumer, request, claimed,
      close: async () => { await pool.close(); await admin.close(); } };
  } catch (error) { await pool.close(); await admin.close(); throw error; }
}
export async function denied(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
}
