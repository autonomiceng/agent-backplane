import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { testApp, signUp, principalFixture } from "../testing/session.ts";

test("signup loses seeded membership or missing session permits Workspace creation", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const app = await testApp(pool);
    const cookie = await signUp(app, "membership@example.com");
    const response = await app.handle(new Request("http://localhost/api/auth/get-session", { headers: { cookie } }));
    expect(response.status).toBe(200);
    const session = await response.json() as { user: { id: string } };
    expect(session.user.id).toBeString();
    const members = await pool`SELECT "organizationId", "userId", role FROM control.member WHERE "userId" = ${session.user.id}`;
    expect(members).toEqual([{ organizationId: "default", userId: session.user.id, role: "member" }]);
    const denied = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Unauthenticated" }),
    }));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "unauthorized" });
    const crossOrigin = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "Cross-origin" }),
    }));
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toEqual({ error: "origin_forbidden" });
    const createOrganization = await app.handle(new Request("http://localhost/api/auth/organization/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Other", slug: "other", userId: session.user.id }),
    }));
    expect(createOrganization.status).toBe(404);
    const [organizations] = await pool`SELECT count(*)::int AS n FROM control.organization`;
    expect(organizations?.n).toBe(1);
    const leaveOrganization = await app.handle(new Request("http://localhost/api/auth/organization/leave", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" },
      body: JSON.stringify({ organizationId: "default" }),
    }));
    expect(leaveOrganization.status).toBe(404);
    const remainingMembers = await pool`SELECT "organizationId", "userId", role FROM control.member WHERE "userId" = ${session.user.id}`;
    expect(remainingMembers).toEqual(members);
    const [count] = await pool`SELECT count(*)::int AS n FROM control.workspaces`;
    expect(count?.n).toBe(0);
  } finally {
    await pool.close();
  }
});

test("bodyless User POST accepts a trusted Origin without Content-Type and refuses CSRF", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const { app, cookie, workspaceId, principalId } = await principalFixture(pool);
    const base = `http://localhost/api/v1/workspaces/${workspaceId}/principals/${principalId}`;
    const post = (path: string, headers: Record<string, string>) => app.handle(new Request(`${base}${path}`, { method: "POST", headers }));
    const missing = await post("/keys", { cookie });
    expect(missing.status).toBe(403);
    expect(await missing.json()).toEqual({ error: "origin_forbidden" });
    const hostile = await post("/keys", { cookie, origin: "https://evil.example" });
    expect(hostile.status).toBe(403);
    expect(await hostile.json()).toEqual({ error: "origin_forbidden" });
    expect(await pool`SELECT FROM control.principal_keys`).toHaveLength(0);
    expect((await post("/keys", { cookie, origin: "http://localhost" })).status).toBe(201);
    const revoke = await post("/revoke", { cookie, origin: "http://localhost" });
    expect(revoke.status).toBe(200);
    const [principal] = await pool`SELECT status FROM control.principals WHERE id = ${principalId}`;
    expect(principal.status).toBe("revoked");
  } finally { await pool.close(); }
});
