// Exercise the privileged boundary and setup retry against owned PostgreSQL clusters.
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { loadMigrations, migrate } from "./migrations.ts";
import { sqlMigrationRunner } from "./sql-migration-runner.ts";
import { createPool } from "../apps/server/platform/pool.ts";
import { withRunContext } from "../apps/server/runs/with-run-context.ts";
import { adminUrl, migratedDatabase, startCluster } from "../apps/server/testing/postgres.ts";
import { principalFixture, issueKey, createRun, testApp } from "../apps/server/testing/session.ts";

test("a forged Principal role cannot grant server access to another role", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const f = await principalFixture(pool);
    const key = await issueKey(f.app, f.cookie, f.workspaceId, f.principalId);
    const runId = await createRun(f.app, key, f.workspaceId);
    const context = { workspaceId: f.workspaceId, principalId: f.principalId, runId };
    const forgedId = crypto.randomUUID();
    await withRunContext(pool, context, async tx => {
      await tx`INSERT INTO control.principals (workspace_id,id,name,role_name)
        VALUES (${f.workspaceId},${forgedId},'Forged role fixture','bp_server')`;
    });
    const forgedKey = await issueKey(f.app, f.cookie, f.workspaceId, forgedId);
    const forgedRun = await createRun(f.app, forgedKey, f.workspaceId);
    await expect(withRunContext(pool, { workspaceId: f.workspaceId, principalId: forgedId, runId: forgedRun }, async tx => {
      await tx`SELECT control.prepare_sql_roles()`;
    })).rejects.toMatchObject({ message: "principal_role_invalid" });
    const role = await withRunContext(pool, context, async tx => {
      const [row] = await tx`SELECT control.prepare_sql_roles() AS name`;
      return row.name;
    });
    expect(role).toStartWith("bp_p_");
  } finally { await pool.close(); }
});

test("failed login initialization is retryable after the role becomes available", async () => {
  const cluster = await startCluster();
  try {
    await expect(migratedDatabase(cluster.url, 1)).rejects.toBeDefined();
    const sql = new SQL({ url: await migratedDatabase(cluster.url), max: 1 });
    try {
      const [row] = await sql`SELECT current_user AS name`;
      expect(row.name).toBe("bp_server");
    } finally { await sql.close(); }
  } finally { await cluster.stop(); }
}, 15_000);


test("the auth timestamp upgrade preserves a session after the required server restart", async () => {
  const url = await migratedDatabase(undefined, 30);
  const before = createPool(url), admin = new SQL(adminUrl(url));
  let after: ReturnType<typeof createPool> | undefined;
  try {
    const fixture = await principalFixture(before);
    await before.close();
    await migrate(sqlMigrationRunner(admin), await loadMigrations(new URL("./migrations", import.meta.url).pathname));
    after = createPool(url);
    const app = await testApp(after);
    const response = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { cookie: fixture.cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ name: "Upgraded workspace" }),
    }));
    expect(response.status).toBe(201);
    expect((await response.json()).id).toBeString();
  } finally { await before.close(); await after?.close(); await admin.close(); }
});
