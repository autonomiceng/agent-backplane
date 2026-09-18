import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { testApp, signUp } from "../testing/session.ts";
import type { Principal } from "./create-principal.ts";
import type { Workspace } from "./create-workspace.ts";

test("Principal provisioning loses its restricted role or User-stamped second Audit Event", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const app = await testApp(pool);
    const cookie = await signUp(app, "principal@example.com");
    const [user] = await pool`SELECT id FROM control."user" WHERE email = 'principal@example.com'`;
    const workspaceResponse = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Research" }),
    }));
    expect(workspaceResponse.status).toBe(201);
    const workspace = await workspaceResponse.json() as Workspace;
    const response = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspace.id}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Researcher" }),
    }));
    expect(response.status).toBe(201);
    const principal = await response.json() as Principal;
    expect(principal).toMatchObject({ workspaceId: workspace.id, name: "Researcher", status: "active" });
    expect(principal.roleName).toBe(`bp_p_${Buffer.from(workspace.id.replaceAll("-", ""), "hex").toString("base64url")}_${Buffer.from(principal.id.replaceAll("-", ""), "hex").toString("base64url")}`);
    expect(principal.roleName.length).toBe(50);
    const rows = await pool`SELECT id, workspace_id, name, role_name, status, created_at FROM control.principals WHERE system IS NULL`;
    expect(rows).toEqual([{
      id: principal.id, workspace_id: workspace.id, name: "Researcher", role_name: principal.roleName,
      status: "active", created_at: new Date(principal.createdAt),
    }]);
    const roles = await pool`SELECT rolcanlogin, rolinherit, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls,
      EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid) AS is_member_of_anything,
      (SELECT array_agg(g.rolname || ':' || m.admin_option::text || ':' || m.inherit_option::text || ':' || m.set_option::text)
        FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.member WHERE m.roleid = r.oid) AS members,
      has_schema_privilege(r.oid, 'control', 'USAGE') AS control_usage,
      has_schema_privilege(r.oid, 'audit', 'USAGE') AS audit_usage,
      has_function_privilege(r.oid, 'audit.emit(text,text,text[],bigint,jsonb)', 'EXECUTE') AS audit_emit
      FROM pg_roles r WHERE rolname = ${principal.roleName}`;
    expect(roles).toEqual([{
      rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false,
      rolreplication: false, rolbypassrls: false, is_member_of_anything: false,
      // CREATEROLE always grants the creator ADMIN on the new role; nothing may be able to SET or INHERIT it.
      members: ["bp_provisioner:true:false:false"],
      control_usage: false, audit_usage: false, audit_emit: false,
    }]);
    const events = await pool`SELECT workspace_id, position::int, principal_id, run_id, user_id, kind, objects, row_count::int, metadata::text AS metadata
      FROM audit.events WHERE workspace_id = ${workspace.id} ORDER BY position`;
    expect(events).toEqual([
      { workspace_id: workspace.id, position: 1, principal_id: null, run_id: null, user_id: user?.id,
        kind: "workspace.created", objects: [workspace.id], row_count: 1, metadata: "{}" },
      { workspace_id: workspace.id, position: 2, principal_id: null, run_id: null, user_id: user?.id,
        kind: "principal.created", objects: [principal.id], row_count: 1, metadata: "{}" },
    ]);
  } finally {
    await pool.close();
  }
});

test("cross-Workspace access provisions a Principal or loses the rejected attempt", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const app = await testApp(pool);
    const cookie = await signUp(app, "outsider@example.com");
    const [user] = await pool`SELECT id FROM control."user" WHERE email = 'outsider@example.com'`;
    const workspaceId = crypto.randomUUID();
    // This isolated fixture needs a second Organization despite the production singleton constraint.
    await admin`DROP INDEX control.organization_singleton`;
    await admin`INSERT INTO control.organization (id, name, slug, "createdAt") VALUES ('other', 'Other', 'other', now())`;
    await withRunContext(admin, { workspaceId, userId: "fixture" }, async (tx, emit) => {
      await tx`INSERT INTO control.workspaces (id, organization_id, name) VALUES (${workspaceId}, 'other', 'Private')`;
      await emit("workspace.created", [workspaceId], 1, {});
    });
    const response = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Intruder" }),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "workspace_forbidden" });
    const [count] = await pool`SELECT count(*)::int AS n FROM control.principals WHERE system IS NULL AND workspace_id = ${workspaceId}`;
    expect(count?.n).toBe(0);
    const prefix = `bp_p_${Buffer.from(workspaceId.replaceAll("-", ""), "hex").toString("base64url")}_`;
    expect(await pool`SELECT rolname FROM pg_roles WHERE starts_with(rolname, ${prefix})`).toHaveLength(0);
    expect(await pool`SELECT kind FROM audit.events WHERE workspace_id = ${workspaceId} AND kind = 'principal.created'`).toHaveLength(0);
    const rejections = await pool`SELECT workspace_id, user_id, principal_id, run_id, kind, reason FROM audit.rejections`;
    expect(rejections).toEqual([{
      workspace_id: workspaceId, user_id: user?.id, principal_id: null, run_id: null,
      kind: "principal.created", reason: "workspace_forbidden",
    }]);
  } finally {
    await Promise.all([pool.close(), admin.close()]);
  }
});

test("provisioning without bound context succeeds or a rollback leaks its role", async () => {
  const pool = createPool(await migratedDatabase());
  const workspaceId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  let roleName = "";
  try {
    await expect(pool`SELECT control.create_principal_role(${workspaceId}, ${principalId})`.then())
      .rejects.toMatchObject({ message: "context_missing" });
    await expect(withRunContext(pool, { workspaceId, userId: "rollback-user" }, async (tx) => {
      await expect(tx.savepoint(async (sp) => {
        await sp`SELECT control.create_principal_role(${crypto.randomUUID()}, ${principalId})`;
      })).rejects.toMatchObject({ message: "context_missing" });
      const [role] = await tx`SELECT control.create_principal_role(${workspaceId}, ${principalId}) AS name`;
      roleName = role.name;
      expect(await tx<{ rolname: string }[]>`SELECT rolname FROM pg_roles WHERE rolname = ${roleName}`).toEqual([{ rolname: roleName }]);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(roleName).not.toBe("");
    expect(await pool`SELECT rolname FROM pg_roles WHERE rolname = ${roleName}`).toHaveLength(0);
    expect(await pool`SELECT id FROM control.principals WHERE workspace_id = ${workspaceId}`).toHaveLength(0);
    expect(await pool`SELECT kind FROM audit.events WHERE workspace_id = ${workspaceId}`).toHaveLength(0);
  } finally {
    await pool.close();
  }
});
