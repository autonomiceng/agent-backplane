// Expiry must remove physical payloads without an operator request and retain the built-in Run stamp.
import { SQL } from "bun";
import { loadMigrations, migrate } from "../../../db/migrations.ts";
import { sqlMigrationRunner } from "../../../db/sql-migration-runner.ts";
import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { recoveryFixture, applyMigration, principalFixture } from "../testing/session.ts";
import { scheduledPurge } from "./scheduled-purge.ts";

test("the retention interval purges expired SQL under its credentialless system Principal", async () => {
  const url=await migratedDatabase(), pool=createPool(url), admin=createPool(adminUrl(url));
  let stop: (()=>Promise<void>) | undefined;
  try {
    const f=await recoveryFixture(pool);
    const response=await f.app.handle(new Request(`${f.baseUrl}/retention`, {method:"PUT",headers:f.userHeaders,body:'{"seconds":1}'}));
    expect(response.status).toBe(200);
    await applyMigration(f.app,f.key,f.runId,f.workspaceId,"CREATE TABLE expiring_sql (id integer PRIMARY KEY)");
    await pool`SELECT pg_sleep(greatest(0,extract(epoch FROM max(expires_at)-clock_timestamp()))+0.01) FROM control.workspace_migrations WHERE workspace_id=${f.workspaceId}`;
    stop=scheduledPurge(pool,30);
    const deadline=Date.now()+3000;
    let purged=false;
    while (Date.now()<deadline) {
      const [row]=await pool`SELECT sql IS NULL AS purged FROM control.workspace_migrations WHERE workspace_id=${f.workspaceId}`;
      if (row?.purged) { purged=true; break; }
      await Bun.sleep(20);
    }
    await stop(); stop=undefined;
    expect(purged).toBe(true);
    const [event]=await pool`SELECT p.name,p.system,r.harness,e.user_id,e.run_id FROM audit.events e
      JOIN control.principals p ON (p.workspace_id,p.id)=(e.workspace_id,e.principal_id)
      JOIN control.runs r ON r.id=e.run_id WHERE e.workspace_id=${f.workspaceId} AND e.kind='retention.purged' LIMIT 1`;
    expect(event).toMatchObject({name:"retention",system:"retention",harness:"backplane",user_id:null});
    expect(event.run_id).toBeString();
    const [privileges]=await admin`SELECT EXISTS(SELECT FROM pg_roles WHERE rolname=p.role_name) AS role,
      EXISTS(SELECT FROM control.principal_keys k WHERE k.workspace_id=p.workspace_id AND k.principal_id=p.id) AS credential
      FROM control.principals p WHERE workspace_id=${f.workspaceId} AND system='retention'`;
    expect(privileges).toEqual({role:false,credential:false});
  } finally { await stop?.(); await pool.close(); await admin.close(); }
},10000);

test("system Principal installation drops legacy roles and runs as bp_provisioner after upgrade", async () => {
  const url = await migratedDatabase(undefined, 29), pool = createPool(url), admin = new SQL(adminUrl(url));
  try {
    const fixture = await principalFixture(pool);
    const roles = await pool<{ role_name: string }[]>`SELECT role_name FROM control.principals WHERE system IS NOT NULL`;
    await migrate(sqlMigrationRunner(admin), (await loadMigrations(new URL("../../../db/migrations", import.meta.url).pathname)).filter(m => m.version <= 30));
    const owners = await pool`SELECT p.proname,r.rolname,r.rolsuper FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid IN ('control.install_system_principals(uuid)'::regprocedure,'control.workspace_system_principals()'::regprocedure)`;
    expect(owners).toHaveLength(2);
    for (const owner of owners) { expect(owner.rolname).toBe("bp_provisioner"); expect(owner.rolsuper).toBe(false); }
    for (const role of roles) expect(await pool`SELECT FROM pg_roles WHERE rolname=${role.role_name}`).toHaveLength(0);
    const response = await fixture.app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { cookie: fixture.cookie, origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ name: "After upgrade" }),
    }));
    expect(response.status).toBe(201);
    const workspace = await response.json();
    expect(await pool`SELECT FROM control.principals WHERE workspace_id=${workspace.id} AND system IS NOT NULL`).toHaveLength(2);
  } finally { await pool.close(); await admin.close(); }
});
