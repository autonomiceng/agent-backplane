import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { createRun, issueKey, principalFixture, signUp } from "../testing/session.ts";
import { withRunContext } from "../runs/with-run-context.ts";

test("User bypasses Organization membership or a bad Bearer falls back to a valid cookie", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const { app, cookie, workspaceId, principalId } = await principalFixture(pool);
    const key = await issueKey(app, cookie, workspaceId, principalId);
    await createRun(app, key, workspaceId);
    const outsider = await signUp(app, "audit-outsider@example.com");
    const [user] = await pool`SELECT id FROM control."user" WHERE email = 'audit-outsider@example.com'`;
    // Identity membership has no Workspace write path; remove the signup enrollment to model an outsider.
    await withRunContext(pool, { workspaceId, userId: user.id }, async (tx) => {
      await tx`DELETE FROM control.member WHERE "userId" = ${user.id}`;
    });
    const url = `http://localhost/api/v1/workspaces/${workspaceId}/audit`;
    const forbidden = await app.handle(new Request(url, { headers: { cookie: outsider } }));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "workspace_forbidden" });
    const member = await app.handle(new Request(url, { headers: { cookie } }));
    const principal = await app.handle(new Request(url, { headers: { authorization: `Bearer ${key}` } }));
    expect(member.status).toBe(200);
    expect(principal.status).toBe(200);
    expect(await member.json()).toEqual(await principal.json());
    const otherWorkspaceResponse = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Other" }),
    }));
    expect(otherWorkspaceResponse.status).toBe(201);
    const otherWorkspace = await otherWorkspaceResponse.json() as { id: string };
    const wrongWorkspace = await app.handle(new Request(`http://localhost/api/v1/workspaces/${otherWorkspace.id}/audit`, {
      headers: { authorization: `Bearer ${key}` },
    }));
    expect(wrongWorkspace.status).toBe(403);
    expect(await wrongWorkspace.json()).toEqual({ error: "workspace_forbidden" });
    const otherStream = await app.handle(new Request(`http://localhost/api/v1/workspaces/${otherWorkspace.id}/audit`, { headers: { cookie } }));
    expect(otherStream.status).toBe(200);
    expect(await otherStream.json()).toMatchObject({ events: [{ kind: "workspace.created", objects: [otherWorkspace.id] }], nextAfter: "1" });
    const badBearer = await app.handle(new Request(url, { headers: { cookie, authorization: "Bearer invalid" } }));
    expect(badBearer.status).toBe(401);
    expect(await badBearer.json()).toEqual({ error: "unauthorized" });
    const missing = await app.handle(new Request(url));
    expect(missing.status).toBe(401);
  } finally {
    await pool.close();
  }
});
