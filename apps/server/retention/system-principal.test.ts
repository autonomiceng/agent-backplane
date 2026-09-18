// Maintenance uses bp_server with a bound Run, so database guards must enforce its purpose.
import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { recoveryFixture, applyMigration } from "../testing/session.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { prepareSql } from "../sql/prepare-sql.ts";
import { executeSqlIn } from "../sql/execute-sql-in.ts";

test("maintenance Runs cannot create Queues through bp_server", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const f = await recoveryFixture(pool);
    const principals = await pool<{ workspaceId: string; principalId: string; system: string }[]>`
      SELECT workspace_id AS "workspaceId", id AS "principalId", system FROM control.principals
      WHERE workspace_id=${f.workspaceId} AND system IS NOT NULL ORDER BY system`;
    expect(principals.map(p => p.system)).toEqual(["operations", "retention"]);
    for (const principal of principals) {
      await expect(withRunContext(pool, principal, async tx => {
        await tx`SELECT queue.create_queue(${f.workspaceId},'forbidden')`;
      }, { newRun: { harness: "backplane" } })).rejects.toThrow("context_missing");
    }
    expect(await pool`SELECT name FROM queue.queues WHERE workspace_id=${f.workspaceId} AND name='forbidden'`).toHaveLength(0);
  } finally { await pool.close(); }
});

test("maintenance Runs cannot insert blob metadata through bp_server", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const f = await recoveryFixture(pool);
    const principals = await pool<{ workspaceId: string; principalId: string; system: string }[]>`
      SELECT workspace_id AS "workspaceId", id AS "principalId", system FROM control.principals
      WHERE workspace_id=${f.workspaceId} AND system IS NOT NULL ORDER BY system`;
    expect(principals.map(p => p.system)).toEqual(["operations", "retention"]);
    for (const principal of principals) {
      await expect(withRunContext(pool, principal, async tx => {
        await tx`INSERT INTO control.blobs(workspace_id,id,key,size,sha256,content_type)
          VALUES(${f.workspaceId},${crypto.randomUUID()},'forbidden',0,sha256(''::bytea),'text/plain')`;
      }, { newRun: { harness: "backplane" } })).rejects.toThrow("run_required");
    }
    expect(await pool`SELECT id FROM control.blobs WHERE workspace_id=${f.workspaceId}`).toHaveLength(0);
  } finally { await pool.close(); }
});

test("maintenance Runs cannot gain Workspace SQL privileges through the executor", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const f = await recoveryFixture(pool);
    await applyMigration(f.app, f.key, f.runId, f.workspaceId, "CREATE TABLE system_write (id integer PRIMARY KEY)");
    const principals = await pool<{ workspaceId: string; principalId: string; system: string }[]>`
      SELECT workspace_id AS "workspaceId", id AS "principalId", system FROM control.principals
      WHERE workspace_id=${f.workspaceId} AND system IS NOT NULL ORDER BY system`;
    expect(principals.map(p => p.system)).toEqual(["operations", "retention"]);
    for (const principal of principals) {
      await expect(withRunContext(pool, principal, async (tx, emit, runId) => {
        if (!runId) throw new Error("run_required");
        const context = { ...principal, runId };
        const prepared = await prepareSql(context, { statement: "INSERT INTO system_write (id) VALUES (1)", params: [] });
        if (!prepared.ok) throw new Error(prepared.error);
        await executeSqlIn(tx, emit, context, prepared);
      }, { newRun: { harness: "backplane" } })).rejects.toThrow("context_missing");
    }
    const response = await f.app.handle(new Request(`${f.baseUrl}/sql`, {
      method: "POST", headers: f.headers,
      body: JSON.stringify({ statement: "SELECT id FROM system_write", params: [] }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rows: [] });
  } finally { await pool.close(); }
});
