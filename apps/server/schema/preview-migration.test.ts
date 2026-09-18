import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createPool } from "../platform/pool.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { adminUrl } from "../testing/postgres.ts";
import { applyMigration, migrationFixture } from "../testing/session.ts";
import type { PreviewResponse } from "./preview-migration-input.ts";

test("dry-run persists schema, data or ledger rows, leaks SQL into audit, or accepts a broken populated contract", async () => {
  const { pool, url, app, key, workspaceId, principalId, runId, schema, preview, sql } = await migrationFixture();
  const admin = createPool(adminUrl(url));
  try {
    const source = "CREATE TABLE items (id int, note text); INSERT INTO items (id, note) VALUES (1, 'private-é;')";
    const response = await preview(source);
    expect(response.status).toBe(200);
    const body = await response.json() as PreviewResponse;
    expect(body).toMatchObject({ revision: 0, sqlHash: createHash("sha256").update(source).digest("hex"), destructive: false,
      statements: [{ kind: "CreateStmt", target: "items", destructive: false }, { kind: "InsertStmt", target: "items", destructive: false }] });
    expect(await pool`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`).toHaveLength(0);
    expect(await pool`SELECT rolname FROM pg_roles WHERE rolname = ${`bp_${schema}`}`).toHaveLength(0);
    expect(await pool`SELECT revision FROM control.workspace_migrations WHERE workspace_id = ${workspaceId}`).toHaveLength(0);
    const events = await pool`SELECT position::text, objects, row_count::int, metadata::text, principal_id, run_id FROM audit.events
      WHERE workspace_id = ${workspaceId} AND kind = 'migration.previewed'`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ position: body.previewPosition, objects: ["items"], row_count: 2, principal_id: principalId, run_id: runId });
    expect(JSON.parse(events[0].metadata)).toEqual({ revision: 0, sqlHash: body.sqlHash, destructive: false, policyVersion: 1 });
    expect(events[0].metadata).not.toContain("private");
    const repeated = await preview(source);
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as PreviewResponse).sqlHash).toBe(body.sqlHash);
    const forbidden = await preview("CREATE TABLE t (id int); CREATE VIEW v AS SELECT 1");
    expect(forbidden.status).toBe(422);
    expect(await forbidden.json()).toEqual({ error: "migration_statement_forbidden", statementIndex: 1 });
    const foreignKey = await preview(`CREATE TABLE parents (id int PRIMARY KEY);
      CREATE TABLE children (id int PRIMARY KEY, parent_id int REFERENCES parents(id) ON DELETE RESTRICT);
      INSERT INTO parents (id) VALUES (1); INSERT INTO children (id, parent_id) VALUES (1, 1)`);
    expect(foreignKey.status).toBe(200);
    expect(await foreignKey.json()).toMatchObject({ destructive: false, statements: [
      { kind: "CreateStmt", target: "parents" }, { kind: "CreateStmt", target: "children" },
      { kind: "InsertStmt", target: "parents" }, { kind: "InsertStmt", target: "children" },
    ] });
    expect(await pool`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`).toHaveLength(0);
    await applyMigration(app, key, runId, workspaceId, "CREATE TABLE items (id int, note text)");
    expect((await sql("INSERT INTO items (id, note) VALUES (1, 'original')")).status).toBe(200);
    const provisioned = await preview("ALTER TABLE items ADD COLUMN extra text", false, 1);
    expect(provisioned.status).toBe(200);
    const [principal] = await pool<{ role_name: string }[]>`SELECT role_name FROM control.principals
      WHERE workspace_id = ${workspaceId} AND id = ${principalId}`;
    if (!principal) throw new Error("missing Principal role");
    expect(await pool<{ inherit_option: boolean; set_option: boolean }[]>`SELECT m.inherit_option, m.set_option
      FROM pg_auth_members m JOIN pg_roles role ON role.oid = m.roleid JOIN pg_roles member ON member.oid = m.member
      WHERE role.rolname = ${`bp_${schema}`} AND member.rolname = ${principal.role_name}`)
      .toEqual([{ inherit_option: true, set_option: false }]);
    expect(await pool<{ inherit_option: boolean; set_option: boolean }[]>`SELECT m.inherit_option, m.set_option
      FROM pg_auth_members m JOIN pg_roles role ON role.oid = m.roleid JOIN pg_roles member ON member.oid = m.member
      WHERE role.rolname = ${principal.role_name} AND member.rolname = 'bp_server'`)
      .toEqual([{ inherit_option: false, set_option: true }]);
    expect(await pool<{ owner: string }[]>`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = ${schema}`)
      .toEqual([{ owner: "bp_executor" }]);
    await withRunContext(admin, { workspaceId, principalId, runId }, async (tx) => {
      await tx`ALTER TABLE ${tx(schema)}.items ALTER COLUMN note SET DEFAULT lower('unsafe')`;
    });
    const unsafeDefault = await preview("ALTER TABLE items ADD COLUMN extra text", false, 1);
    expect(unsafeDefault.status).toBe(422);
    expect(await unsafeDefault.json()).toEqual({ error: "workspace_contract_invalid" });
    await withRunContext(admin, { workspaceId, principalId, runId }, async (tx) => {
      await tx`ALTER TABLE ${tx(schema)}.items ALTER COLUMN note DROP DEFAULT`;
    });
    // Deliberately damage the test fixture under bound context after its data was written through HTTP.
    await withRunContext(admin, { workspaceId, principalId, runId }, async (tx) => {
      await tx`ALTER TABLE ${tx(schema)}.items DROP COLUMN run_id`;
    });
    const invalid = await preview("ALTER TABLE items ADD COLUMN extra text", false, 1);
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: "workspace_contract_invalid" });
    expect(await admin<{ id: number; note: string }[]>`SELECT id, note FROM ${admin(schema)}.items`).toEqual([{ id: 1, note: "original" }]);
    expect(await pool`SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema} AND a.attname = 'extra' AND NOT a.attisdropped`).toHaveLength(0);
    expect(await pool<{ reason: string }[]>`SELECT reason FROM audit.rejections WHERE workspace_id = ${workspaceId} ORDER BY id`)
      .toEqual([{ reason: "migration_statement_forbidden" }, { reason: "workspace_contract_invalid" }, { reason: "workspace_contract_invalid" }]);
  } finally { await admin.close(); await pool.close(); }
});

test("unflagged drop is executed, flagged preview deletes the table, or a stale revision is accepted", async () => {
  const { pool, app, key, runId, workspaceId, schema, preview } = await migrationFixture();
  try {
    await applyMigration(app, key, runId, workspaceId, "CREATE TABLE items (id int PRIMARY KEY)");
    const before = await pool`SELECT position FROM audit.events WHERE kind = 'migration.previewed' AND workspace_id = ${workspaceId}`;
    const rejected = await preview("DROP TABLE items", false, 1);
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toEqual({ error: "migration_destructive_unflagged" });
    expect(await pool`SELECT position FROM audit.events WHERE kind = 'migration.previewed' AND workspace_id = ${workspaceId}`).toEqual(before);
    expect(await pool`SELECT revision FROM control.workspace_migrations WHERE workspace_id = ${workspaceId}`).toHaveLength(1);
    const accepted = await preview("DROP TABLE items", true, 1);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ destructive: true, statements: [{ kind: "DropStmt", target: "items", destructive: true }] });
    expect(await pool`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname = 'items'`).toHaveLength(1);
    const upsert = await preview("INSERT INTO items (id) VALUES (1) ON CONFLICT ON CONSTRAINT items_pkey DO UPDATE SET id = 2", false, 1);
    expect(upsert.status).toBe(422);
    expect(await upsert.json()).toEqual({ error: "migration_destructive_unflagged" });
    const overflow = await preview("DROP TABLE items", false, 2147483647);
    expect(overflow.status).toBe(422);
    expect(await overflow.json()).toEqual({ error: "invalid_input" });
    const stale = await preview("DROP TABLE items", false, 3);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "revision_stale" });
    const staleForbidden = await preview("RESET ROLE", false, 3);
    expect(staleForbidden.status).toBe(409);
    expect(await staleForbidden.json()).toEqual({ error: "revision_stale" });
    expect(await pool<{ reason: string }[]>`SELECT reason FROM audit.rejections WHERE workspace_id = ${workspaceId} ORDER BY id`)
      .toEqual([{ reason: "migration_destructive_unflagged" }, { reason: "migration_destructive_unflagged" },
        { reason: "revision_stale" }, { reason: "revision_stale" }]);
  } finally { await pool.close(); }
});
