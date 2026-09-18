import { expect, test } from "bun:test";
import { createPool } from "../../server/platform/pool.ts";
import { migratedDatabase } from "../../server/testing/postgres.ts";
import { recoveryFixture } from "../../server/testing/session.ts";
import type { Claim } from "../../server/queue/claim-input.ts";
import type { PrincipalsPage } from "../../server/auth/list-principals-input.ts";
import { renderPrincipals } from "../testing/render-principals.tsx";
import { createPrincipals } from "./principals.ts";

test("UI reports a rejected revocation as successful", async () => {
  const pool = createPool(await migratedDatabase());
  let client: ReturnType<typeof createPrincipals> | undefined;
  try {
    const f = await recoveryFixture(pool);
    const { app, workspaceId, principalId, cookie, baseUrl } = f;
    const listUrl = `${baseUrl}/principals`;
    const unissuedResponse = await app.handle(new Request(listUrl, {
      method: "POST", headers: f.userHeaders, body: JSON.stringify({ name: "Unissued" }),
    }));
    expect(unissuedResponse.status).toBe(201);
    const unissued = await unissuedResponse.json() as { id: string };
    expect((await f.send("principal-dashboard")).status).toBe(201);
    const claimResponse = await f.claim();
    expect(claimResponse.status).toBe(200);
    const claim = await claimResponse.json() as Claim;
    const begin = await app.handle(new Request(`${baseUrl}/deliveries/${claim.deliveryId}/begin-effect`, {
      method: "POST", headers: f.headers,
      body: JSON.stringify({ receipt: claim.receipt, action: "submit", destination: "example" }),
    }));
    expect(begin.status).toBe(200);
    let origin = "https://foreign.example";
    let release: Promise<void> = Promise.resolve();
    const fetcher: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set("cookie", cookie);
      if (request.method === "POST") {
        request.headers.set("origin", origin);
        await release;
      }
      return app.handle(request);
    }, { preconnect: fetch.preconnect });
    client = createPrincipals("http://localhost", workspaceId, fetcher, 1);
    await client.refresh();
    const first = client.getSnapshot().items[0]!;
    expect(client.getSnapshot().nextCursor).not.toBeNull();
    await client.next();
    const second = client.getSnapshot().items[0]!;
    expect(first.id < second.id).toBe(true);
    expect(client.getSnapshot().nextCursor).toBeNull();
    const rows = [first, second];
    const principal = rows.find((row) => row.id === principalId)!;
    const metadata = await app.handle(new Request(`${listUrl}/${principalId}/keys`, { headers: { cookie } }));
    expect(principal).toEqual({ id: principalId, workspaceId, name: "Researcher", status: "active", credential: await metadata.json() });
    expect(rows.find((row) => row.id === unissued.id)).toEqual({ id: unissued.id, workspaceId, name: "Unissued", status: "active", credential: null });
    expect(JSON.stringify(rows)).not.toContain(f.key);
    await client.previous();
    expect(client.getSnapshot().items).toEqual([first]);
    if (first.id !== principalId) await client.next();
    client.select(principal);
    expect(renderPrincipals(client)).toContain("Confirm revocation");
    client.cancel();
    expect(renderPrincipals(client)).not.toContain("Confirm revocation");
    client.select(principal);
    await client.confirm();
    expect(client.getSnapshot().items[0]?.status).toBe("active");
    expect(renderPrincipals(client)).toContain('role="alert">origin_forbidden');
    expect(renderPrincipals(client)).not.toContain("Principal revoked.");
    expect(renderPrincipals(client)).toContain(">Close</button>");
    client.cancel();
    expect(client.getSnapshot().revocation).toBeNull();
    const begun = await f.list("?state=begun", f.userHeaders);
    expect(begun.status).toBe(200);
    expect(await begun.json()).toMatchObject({ items: [{ id: claim.deliveryId, state: "begun" }] });
    origin = "http://localhost";
    const gate = Promise.withResolvers<void>();
    release = gate.promise;
    client.select(principal);
    const confirmation = client.confirm();
    expect(renderPrincipals(client)).toContain('role="status">Revoking');
    expect(renderPrincipals(client)).not.toContain("Principal revoked.");
    gate.resolve();
    await confirmation;
    expect(client.getSnapshot().items[0]?.status).toBe("revoked");
    expect(renderPrincipals(client)).toContain("Principal revoked.");
    expect(renderPrincipals(client)).toContain("1 Effects paused by this request.");
    expect(renderPrincipals(client)).toContain(">Close</button>");
    client.cancel();
    expect(renderPrincipals(client)).not.toContain("Principal revoked.");
    const paused = await f.list("?state=effect-paused", f.userHeaders);
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ items: [{ id: claim.deliveryId, state: "effect-paused" }] });
    expect((await f.receipt(claim.deliveryId, claim.receipt, "ack")).status).toBe(401);
    expect((await app.handle(new Request(`${baseUrl}/whoami`, { headers: { authorization: `Bearer ${f.key}` } }))).status).toBe(401);
    const events = await pool`SELECT kind, user_id, principal_id, run_id FROM audit.events
      WHERE workspace_id = ${workspaceId} AND kind IN ('principal.revoked', 'effect.paused') ORDER BY position`;
    const [user] = await pool`SELECT id FROM control."user"`;
    expect(events).toEqual([
      { kind: "principal.revoked", user_id: user?.id, principal_id: null, run_id: null },
      { kind: "effect.paused", user_id: user?.id, principal_id: null, run_id: null },
    ]);
    client.select(client.getSnapshot().items[0]!);
    await client.confirm();
    expect(renderPrincipals(client)).toContain("0 Effects paused by this request.");
    expect(await pool`SELECT kind, user_id, principal_id, run_id FROM audit.events
      WHERE workspace_id = ${workspaceId} AND kind IN ('principal.revoked', 'effect.paused') ORDER BY position`).toEqual(events);
    expect((await app.handle(new Request(listUrl))).status).toBe(401);
    expect((await app.handle(new Request(listUrl, { headers: { authorization: `Bearer ${f.key}` } }))).status).toBe(401);
    const forbidden = await app.handle(new Request(`http://localhost/api/v1/workspaces/${crypto.randomUUID()}/principals`, { headers: { cookie } }));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "workspace_forbidden" });
    const malformed = await app.handle(new Request(`${listUrl}?after=broken`, { headers: { cookie } }));
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toEqual({ error: "invalid_input" });
    const exhaustion = Buffer.from(JSON.stringify({ v: 1, workspaceId, id: second.id })).toString("base64url");
    const noncanonical = await app.handle(new Request(`${listUrl}?after=${exhaustion}!`, { headers: { cookie } }));
    expect(noncanonical.status).toBe(422);
    expect(await noncanonical.json()).toEqual({ error: "invalid_input" });
    const end = await app.handle(new Request(`${listUrl}?after=${exhaustion}`, { headers: { cookie } }));
    expect(end.status).toBe(200);
    expect(end.headers.get("cache-control")).toBe("no-store");
    expect(await end.json() as PrincipalsPage).toEqual({ items: [], nextCursor: null });
  } finally { client?.dispose(); await pool.close(); }
});
