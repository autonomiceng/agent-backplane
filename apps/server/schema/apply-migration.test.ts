import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createPool } from "../platform/pool.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { adminUrl } from "../testing/postgres.ts";
import { applyMigration, createRun, issueKey, migrationFixture } from "../testing/session.ts";
import type { ApplyInput, ApplyResponse } from "./apply-migration-input.ts";
import type { PreviewResponse } from "./preview-migration-input.ts";

async function previewed(fixture: Awaited<ReturnType<typeof migrationFixture>>, sql: string, expectedRevision = 0): Promise<ApplyInput> {
  const response = await fixture.preview(sql, true, expectedRevision);
  expect(response.status).toBe(200);
  const receipt = await response.json() as PreviewResponse;
  return { name: "test migration", sql, expectedRevision, destructive: receipt.destructive,
    sqlHash: receipt.sqlHash, previewPosition: receipt.previewPosition };
}

test("concurrent CAS winners commit two revisions or lose the ledger, audit or installed table contract", async () => {
  const fixture = await migrationFixture(2);
  const { pool, workspaceId, principalId, runId, schema } = fixture;
  try {
    const input = await previewed(fixture, "CREATE TABLE items (id int PRIMARY KEY)");
    const responses = await Promise.all([fixture.apply(input), fixture.apply(input)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const winner = responses.find((response) => response.status === 201);
    const loser = responses.find((response) => response.status === 409);
    if (!winner || !loser) throw new Error("expected one CAS winner");
    expect(winner.headers.get("cache-control")).toBe("no-store");
    const applied = await winner.json() as ApplyResponse;
    expect(applied).toMatchObject({ revision: 1, name: input.name, sqlHash: input.sqlHash });
    expect(applied.appliedAt).toBe(new Date(applied.appliedAt).toISOString());
    expect(await loser.json()).toEqual({ error: "revision_stale" });
    expect(await pool<{ revision: number; sql: string; sql_hash: string; applied_by: string; run_id: string }[]>`
      SELECT revision, sql, encode(sql_hash, 'hex') AS sql_hash, applied_by, run_id FROM control.workspace_migrations
      WHERE workspace_id = ${workspaceId}`).toEqual([{ revision: 1, sql: input.sql, sql_hash: input.sqlHash, applied_by: principalId, run_id: runId }]);
    const events = await pool`SELECT objects, row_count::int, metadata::text FROM audit.events
      WHERE workspace_id = ${workspaceId} AND kind = 'migration.applied'`;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ objects: ["items"], row_count: 1 });
    expect(JSON.parse(events[0].metadata)).toEqual({ revision: 1, sqlHash: input.sqlHash, destructive: false, policyVersion: 1 });
    expect(events[0].metadata).not.toContain(input.sql);
    expect(await pool<{ name: string; uuid: boolean; not_null: boolean }[]>`SELECT a.attname AS name,
      a.atttypid = 'uuid'::regtype AS uuid, a.attnotnull AS not_null FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname = 'items' AND a.attname IN ('principal_id', 'run_id') ORDER BY a.attname`)
      .toEqual([{ name: "principal_id", uuid: true, not_null: true }, { name: "run_id", uuid: true, not_null: true }]);
    expect(await pool<{ owner: string; enabled: string; stamps: boolean; group_read: boolean; group_write: boolean }[]>`
      SELECT pg_get_userbyid(c.relowner) AS owner, t.tgenabled AS enabled,
        t.tgfoid = 'audit.stamp_workspace_row()'::regprocedure AS stamps,
        has_table_privilege(${`bp_${schema}`}, c.oid, 'SELECT') AS group_read,
        has_table_privilege(${`bp_${schema}`}, c.oid, 'INSERT') AS group_write
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgname = 'bp_stamp'
      WHERE n.nspname = ${schema} AND c.relname = 'items'`)
      .toEqual([{ owner: "bp_executor", enabled: "A", stamps: true, group_read: true, group_write: true }]);
  } finally { await pool.close(); }
});

test("preview and hash mismatch applies unpreviewed, changed, malformed-receipt or foreign SQL", async () => {
  const fixture = await migrationFixture();
  const { app, cookie, pool, url, workspaceId, schema } = fixture;
  const admin = createPool(adminUrl(url));
  try {
    const sql = "CREATE TABLE items (id int)";
    const unpreviewed = await fixture.apply({ name: "missing preview", sql, expectedRevision: 0, destructive: false,
      sqlHash: createHash("sha256").update(sql).digest("hex"), previewPosition: "1" });
    expect(unpreviewed.status).toBe(409);
    expect(await unpreviewed.json()).toEqual({ error: "preview_mismatch" });
    const input = await previewed(fixture, sql);
    const changed = await fixture.apply({ ...input, sql: "CREATE TABLE changed (id int)" });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: "preview_mismatch" });
    const otherHash = await fixture.apply({ ...input, sqlHash: createHash("sha256").update("CREATE TABLE other (id int)").digest("hex") });
    expect(otherHash.status).toBe(409);
    expect(await otherHash.json()).toEqual({ error: "preview_mismatch" });
    const created = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Other Principal" }),
    }));
    expect(created.status).toBe(201);
    const other = await created.json() as { id: string };
    const key = await issueKey(app, cookie, workspaceId, other.id);
    const runId = await createRun(app, key, workspaceId);
    const foreign = await fixture.apply(input, { key, runId });
    expect(foreign.status).toBe(409);
    expect(await foreign.json()).toEqual({ error: "preview_mismatch" });
    const [user] = await pool<{ user_id: string }[]>`SELECT user_id FROM audit.events
      WHERE workspace_id = ${workspaceId} AND kind = 'workspace.created'`;
    if (!user) throw new Error("missing fixture User");
    const metadata = { revision: 0, sqlHash: input.sqlHash, destructive: false, policyVersion: 1 };
    // These invalid receipts are explicitly attributed to the fixture User through the audit writer.
    for (const receipt of [
      { kind: "migration.invalid", metadata },
      { kind: "migration.previewed", metadata: { ...metadata, revision: 1 } },
      { kind: "migration.previewed", metadata: { ...metadata, sqlHash: "0".repeat(64) } },
      { kind: "migration.previewed", metadata: { ...metadata, destructive: true } },
      { kind: "migration.previewed", metadata: { ...metadata, policyVersion: 2 } },
    ]) {
      const position = await withRunContext(admin, { workspaceId, userId: user.user_id }, async (_tx, emit) =>
        emit(receipt.kind, ["items"], 1, receipt.metadata));
      const mismatched = await fixture.apply({ ...input, previewPosition: position.toString() });
      expect(mismatched.status).toBe(409);
      expect(await mismatched.json()).toEqual({ error: "preview_mismatch" });
    }
    const workspaceResponse = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Other Workspace" }),
    }));
    expect(workspaceResponse.status).toBe(201);
    const workspace = await workspaceResponse.json() as { id: string };
    const principalResponse = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspace.id}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Foreign Principal" }),
    }));
    expect(principalResponse.status).toBe(201);
    const principal = await principalResponse.json() as { id: string };
    const foreignKey = await issueKey(app, cookie, workspace.id, principal.id);
    const foreignRun = await createRun(app, foreignKey, workspace.id);
    const foreignSql = "CREATE TABLE foreign_items (id int)";
    const foreignPreview = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspace.id}/migrations/preview`, {
      method: "POST", headers: { authorization: `Bearer ${foreignKey}`, "x-backplane-run": foreignRun, "content-type": "application/json" },
      body: JSON.stringify({ name: input.name, sql: foreignSql, expectedRevision: 0, destructive: false }),
    }));
    expect(foreignPreview.status).toBe(200);
    const foreignReceipt = await foreignPreview.json() as PreviewResponse;
    const foreignWorkspace = await fixture.apply({ ...input, sql: foreignSql,
      sqlHash: foreignReceipt.sqlHash, previewPosition: foreignReceipt.previewPosition });
    expect(foreignWorkspace.status).toBe(409);
    expect(await foreignWorkspace.json()).toEqual({ error: "preview_mismatch" });
    expect(await pool`SELECT nspname FROM pg_namespace WHERE nspname = ${`ws_${workspace.id.replaceAll("-", "")}`}`).toHaveLength(0);
    expect(await pool`SELECT revision FROM control.workspace_migrations WHERE workspace_id = ${workspaceId}`).toHaveLength(0);
    expect(await pool`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`).toHaveLength(0);
    expect(await pool`SELECT position FROM audit.events WHERE workspace_id = ${workspaceId} AND kind = 'migration.applied'`).toHaveLength(0);
    expect(await pool<{ reason: string }[]>`SELECT reason FROM audit.rejections WHERE workspace_id = ${workspaceId} ORDER BY id`)
      .toEqual(Array.from({ length: 10 }, () => ({ reason: "preview_mismatch" })));
  } finally { await admin.close(); await pool.close(); }
});

test("schema-ledger partial commit survives failed audit emission, a failing second statement or a damaged populated contract", async () => {
  const fixture = await migrationFixture();
  const { app, key, pool, url, workspaceId, principalId, runId, schema, sql } = fixture;
  const admin = createPool(adminUrl(url));
  try {
    const auditInput = await previewed(fixture, "CREATE TABLE audit_failure (id int)");
    await admin`REVOKE EXECUTE ON FUNCTION audit.emit(text,text,text[],bigint,jsonb) FROM bp_server`;
    const auditFailure = await fixture.apply(auditInput).finally(async () => {
      await admin`GRANT EXECUTE ON FUNCTION audit.emit(text,text,text[],bigint,jsonb) TO bp_server`;
    });
    expect(auditFailure.status).toBe(422);
    expect(await auditFailure.json()).toEqual({ error: "migration_error", sqlstate: "42501" });
    expect(await pool`SELECT nspname FROM pg_namespace WHERE nspname = ${schema}`).toHaveLength(0);
    expect(await pool`SELECT revision FROM control.workspace_migrations WHERE workspace_id = ${workspaceId}`).toHaveLength(0);
    expect(await pool`SELECT position FROM audit.events WHERE workspace_id = ${workspaceId} AND kind = 'migration.applied'`).toHaveLength(0);
    expect(await pool<{ reason: string; sqlstate: string }[]>`SELECT reason, sqlstate FROM audit.rejections
      WHERE workspace_id = ${workspaceId} AND kind = 'migration.applied'`).toEqual([{ reason: "migration_error", sqlstate: "42501" }]);
    await applyMigration(app, key, runId, workspaceId, "CREATE TABLE source_values (id int); INSERT INTO source_values (id) VALUES (1)");
    const input = await previewed(fixture, "CREATE TABLE checked (id int CHECK (id > 0)); INSERT INTO checked (id) SELECT id FROM source_values", 1);
    expect((await sql("UPDATE source_values SET id = -1")).status).toBe(200);
    const response = await fixture.apply(input);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "migration_error", sqlstate: "23514" });
    expect(await pool`SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname = 'checked'`).toHaveLength(0);
    expect(await pool<{ revision: number }[]>`SELECT revision FROM control.workspace_migrations WHERE workspace_id = ${workspaceId}`)
      .toEqual([{ revision: 1 }]);
    expect(await pool`SELECT position FROM audit.events WHERE workspace_id = ${workspaceId} AND kind = 'migration.applied'`).toHaveLength(1);
    expect(await pool<{ reason: string; sqlstate: string }[]>`SELECT reason, sqlstate FROM audit.rejections
      WHERE workspace_id = ${workspaceId} AND kind = 'migration.applied' ORDER BY id`)
      .toEqual([{ reason: "migration_error", sqlstate: "42501" }, { reason: "migration_error", sqlstate: "23514" }]);
    const alter = await previewed(fixture, "ALTER TABLE source_values ADD COLUMN note text", 1);
    // Damage the contract only after obtaining a valid preview; ordinary fixture writes use HTTP.
    await withRunContext(admin, { workspaceId, principalId, runId }, async (tx) => {
      await tx`ALTER TABLE ${tx(schema)}.source_values DROP COLUMN run_id`;
    });
    const invalid = await fixture.apply(alter);
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: "workspace_contract_invalid" });
    expect(await admin<{ id: number }[]>`SELECT id FROM ${admin(schema)}.source_values`).toEqual([{ id: -1 }]);
    expect(await pool`SELECT a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema} AND c.relname = 'source_values'
      AND a.attname = 'note' AND NOT a.attisdropped`).toHaveLength(0);
    expect(await pool<{ revision: number }[]>`SELECT revision FROM control.workspace_migrations WHERE workspace_id = ${workspaceId}`)
      .toEqual([{ revision: 1 }]);
    expect(await pool`SELECT position FROM audit.events WHERE workspace_id = ${workspaceId} AND kind = 'migration.applied'`).toHaveLength(1);
  } finally { await admin.close(); await pool.close(); }
});

test("incorrect ownership or grants expose another Workspace or lose the applying Principal and Run", async () => {
  const fixture = await migrationFixture();
  const { app, cookie, key, pool, workspaceId, principalId, runId, schema, sql } = fixture;
  try {
    await applyMigration(app, key, runId, workspaceId, "CREATE TABLE items (id int PRIMARY KEY, note text)");
    const grantFacts = await pool`SELECT pg_get_userbyid(c.relowner) AS owner, t.tgenabled AS enabled,
      has_table_privilege(p.role_name, c.oid, 'SELECT') AS principal_read,
      has_table_privilege(p.role_name, c.oid, 'INSERT') AS principal_write,
      (SELECT array_agg(a.privilege_type ORDER BY a.privilege_type) FROM aclexplode(c.relacl) a
        WHERE a.grantee = ${`bp_${schema}`}::regrole) AS group_privileges,
      EXISTS (SELECT FROM aclexplode(c.relacl) a WHERE a.grantee = quote_ident(p.role_name)::regrole OR a.grantee = 0) AS direct_or_public
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgname = 'bp_stamp'
      JOIN control.principals p ON p.workspace_id = ${workspaceId} AND p.id = ${principalId}
      WHERE n.nspname = ${schema} AND c.relname = 'items'`;
    expect(grantFacts).toHaveLength(1);
    expect(grantFacts[0]).toEqual({ owner: "bp_executor", enabled: "A", principal_read: true, principal_write: true,
      group_privileges: ["DELETE", "INSERT", "SELECT", "UPDATE"], direct_or_public: false });
    const data = await previewed(fixture, "INSERT INTO items (id, note) VALUES (1, 'applied')", 1);
    const applyingRun = await createRun(app, key, workspaceId);
    const applied = await fixture.apply(data, { key, runId: applyingRun });
    expect(applied.status).toBe(201);
    expect(await applied.json()).toMatchObject({ revision: 2 });
    const rows = await sql("SELECT id, note, principal_id, run_id FROM items");
    expect(rows.status).toBe(200);
    expect(await rows.json()).toMatchObject({ rows: [{ id: 1, note: "applied", principal_id: principalId, run_id: applyingRun }] });
    expect((await sql("UPDATE items SET note = 'writable' WHERE id = 1")).status).toBe(200);
    const otherWorkspace = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Other Workspace" }),
    }));
    expect(otherWorkspace.status).toBe(201);
    const workspace = await otherWorkspace.json() as { id: string };
    const created = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspace.id}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Outsider" }),
    }));
    expect(created.status).toBe(201);
    const other = await created.json() as { id: string };
    const otherKey = await issueKey(app, cookie, workspace.id, other.id);
    const otherRun = await createRun(app, otherKey, workspace.id);
    const forbidden = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspaceId}/sql`, {
      method: "POST", headers: { authorization: `Bearer ${otherKey}`, "x-backplane-run": otherRun, "content-type": "application/json" },
      body: JSON.stringify({ statement: "SELECT * FROM items", params: [] }),
    }));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "workspace_forbidden" });
  } finally { await pool.close(); }
});
