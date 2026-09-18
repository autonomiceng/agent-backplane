import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { testApp, signUp } from "../testing/session.ts";

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
