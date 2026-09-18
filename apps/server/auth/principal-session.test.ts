import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { issueKey, principalFixture } from "../testing/session.ts";

test("scope escape accepts another Workspace, invalid credentials or the wrong actor's authentication", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const { app, cookie, workspaceId, principalId } = await principalFixture(pool);
    const key = await issueKey(app, cookie, workspaceId, principalId);
    const other = await app.handle(new Request(`http://localhost/api/v1/workspaces/${crypto.randomUUID()}/whoami`, {
      headers: { authorization: `Bearer ${key}` },
    }));
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: "workspace_forbidden" });
    const whoami = `http://localhost/api/v1/workspaces/${workspaceId}/whoami`;
    const malformed = await app.handle(new Request(whoami, { headers: { authorization: "Bearer bp_broken" } }));
    expect(malformed.status).toBe(401);
    const unknown = await app.handle(new Request(whoami, { headers: { authorization: `Bearer bp_${"0".repeat(24)}_${"0".repeat(64)}` } }));
    expect(unknown.status).toBe(401);
    const wrong = await app.handle(new Request(whoami, { headers: { authorization: `Bearer ${key.slice(0, -1)}${key.endsWith("0") ? "1" : "0"}` } }));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "unauthorized" });
    const userRoute = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Escape" }),
    }));
    expect(userRoute.status).toBe(401);
    expect((await app.handle(new Request(whoami, { headers: { cookie } }))).status).toBe(401);

    const privateWorkspaceId = crypto.randomUUID();
    // This isolated fixture needs a second Organization despite the production singleton constraint.
    await admin`DROP INDEX control.organization_singleton`;
    await admin`INSERT INTO control.organization (id, name, slug, "createdAt") VALUES ('other', 'Other', 'other', now())`;
    await withRunContext(admin, { workspaceId: privateWorkspaceId, userId: "fixture" }, async (tx, emit) => {
      await tx`INSERT INTO control.workspaces (id, organization_id, name) VALUES (${privateWorkspaceId}, 'other', 'Private')`;
      await emit("workspace.created", [privateWorkspaceId], 1, {});
    });
    const privatePrincipal = `http://localhost/api/v1/workspaces/${privateWorkspaceId}/principals/${principalId}`;
    const forbiddenKeys = await app.handle(new Request(`${privatePrincipal}/keys`, { headers: { cookie } }));
    expect(forbiddenKeys.status).toBe(403);
    expect(await forbiddenKeys.json()).toEqual({ error: "workspace_forbidden" });
    const forbiddenRevoke = await app.handle(new Request(`${privatePrincipal}/revoke`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" },
    }));
    expect(forbiddenRevoke.status).toBe(403);
    expect(await forbiddenRevoke.json()).toEqual({ error: "workspace_forbidden" });
    const absentPrincipal = `http://localhost/api/v1/workspaces/${workspaceId}/principals/${crypto.randomUUID()}`;
    const absentKeys = await app.handle(new Request(`${absentPrincipal}/keys`, { headers: { cookie } }));
    expect(absentKeys.status).toBe(404);
    expect(await absentKeys.json()).toEqual({ error: "principal_not_found" });
    const absentRevoke = await app.handle(new Request(`${absentPrincipal}/revoke`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" },
    }));
    expect(absentRevoke.status).toBe(404);
    expect(await absentRevoke.json()).toEqual({ error: "principal_not_found" });
  } finally {
    await Promise.all([pool.close(), admin.close()]);
  }
});
