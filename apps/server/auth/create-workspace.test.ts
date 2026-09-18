import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { testApp, signUp } from "../testing/session.ts";
import type { Workspace } from "./create-workspace.ts";

test("Workspace creation preserves User provenance and audits a rolled-back infrastructure failure", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const app = await testApp(pool);
    const cookie = await signUp(app, "workspace@example.com");
    const [user] = await pool`SELECT id FROM control."user" WHERE email = 'workspace@example.com'`;
    const response = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Research" }),
    }));
    expect(response.status).toBe(201);
    const workspace = await response.json() as Workspace;
    expect(workspace).toMatchObject({ organizationId: "default", name: "Research" });
    const rows = await pool`SELECT id, organization_id, name, created_at FROM control.workspaces`;
    expect(rows).toEqual([{ id: workspace.id, organization_id: "default", name: "Research", created_at: new Date(workspace.createdAt) }]);
    const events = await pool`SELECT workspace_id, position::int, principal_id, run_id, user_id, kind, objects, row_count::int, metadata::text AS metadata
      FROM audit.events WHERE workspace_id = ${workspace.id}`;
    expect(events).toEqual([{
      workspace_id: workspace.id, position: 1, principal_id: null, run_id: null, user_id: user?.id,
      kind: "workspace.created", objects: [workspace.id], row_count: 1, metadata: "{}",
    }]);
    const invalid = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "x".repeat(121) }),
    }));
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: "invalid_input" });
    const [count] = await pool`SELECT count(*)::int AS n FROM control.workspaces`;
    expect(count?.n).toBe(1);
    const [auditCount] = await pool`SELECT count(*)::int AS n FROM audit.events`;
    expect(auditCount?.n).toBe(1);
    await admin.begin(async tx => {
      await tx`LOCK TABLE control.workspaces IN ACCESS EXCLUSIVE MODE`;
      const failed = await app.handle(new Request("http://localhost/api/v1/workspaces", {
        method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Locked" }),
      }));
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ error: "workspace_creation_failed" });
    });
    const [failure] = await pool`SELECT workspace_id, user_id, reason, sqlstate FROM audit.rejections WHERE reason = 'workspace_creation_failed'`;
    expect(failure).toMatchObject({ user_id: user.id, reason: "workspace_creation_failed", sqlstate: "55P03" });
    expect(await pool`SELECT id FROM control.workspaces WHERE id = ${failure.workspace_id}`).toHaveLength(0);
    expect(await pool`SELECT FROM audit.events WHERE workspace_id = ${failure.workspace_id}`).toHaveLength(0);
    await withRunContext(pool, { workspaceId: workspace.id, userId: user.id }, async (tx) => {
      await tx`DELETE FROM control.member WHERE "userId" = ${user.id}`;
    });
    const forbidden = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Forbidden" }),
    }));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "workspace_forbidden" });
    const rejections = await pool`SELECT workspace_id, user_id, kind, objects, reason, sqlstate FROM audit.rejections WHERE reason = 'workspace_forbidden'`;
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({
      user_id: user.id, kind: "workspace.created", objects: [], reason: "workspace_forbidden", sqlstate: null,
    });
    const rejectedWorkspaceId = rejections[0].workspace_id;
    expect(await pool`SELECT id FROM control.workspaces WHERE id = ${rejectedWorkspaceId}`).toHaveLength(0);
    expect(await admin`SELECT workspace_id FROM audit.cursor WHERE workspace_id = ${rejectedWorkspaceId}`).toHaveLength(0);
    expect(await admin`SELECT workspace_id FROM audit.bound_context WHERE workspace_id = ${rejectedWorkspaceId}`).toHaveLength(0);
    expect(await pool`SELECT workspace_id FROM audit.events WHERE workspace_id = ${rejectedWorkspaceId}`).toHaveLength(0);
  } finally {
    await Promise.all([pool.close(), admin.close()]);
  }
});
