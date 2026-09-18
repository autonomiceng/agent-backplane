// One database scenario observes both defects independently without dispatching or emitting audit events.
import { createPool } from "./pool.ts";
import { sampleDisk } from "./disk-sampler.ts";
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Elysia } from "elysia";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { principalFixture, testApp } from "../testing/session.ts";
import { PrincipalAdmission } from "./principal-admission.ts";
import { operationsRoute } from "./operations-route.ts";
import { readOperationsConfig } from "./operations.ts";

test("Operator authentication or stale backup state is misreported", async () => {
  const url=await migratedDatabase(), pool=new SQL({url,max:1}), admin=new SQL({url:adminUrl(url),max:1});
  const dir=await mkdtemp(join(tmpdir(),"bp-operations-"));
  try {
    await pool`SET statement_timeout = '7s'`;
    await pool`SET lock_timeout = '3s'`;
    const fixture=await principalFixture(pool);
    const [identity]=await admin`SELECT (pg_control_system()).system_identifier::text AS id,clock_timestamp() AS now`;
    const manifest=join(dir,"manifest.json"), snapshot={systemId:identity.id,timeline:1,postgres:"180000",schema:23,pgmq:"1",heads:[]};
    await writeFile(manifest,JSON.stringify({name:`bp_${"a".repeat(32)}`,before:snapshot,after:snapshot,targetLsn:"0/1",segment:"000000010000000000000001"}));
    const old=new Date(identity.now.getTime()-90000*1000); await utimes(manifest,old,old);
    const config=readOperationsConfig({BP_OPERATIONS_TOKEN:"operator-secret",BP_BACKUP_DIR:dir,BP_OPERATIONS_EXPIRED_LEASE_MAX_AGE_SECONDS:"5"});
    const app=()=>new Elysia().use(operationsRoute(pool,config,new PrincipalAdmission(),new Map()));
    const request=(a:ReturnType<typeof app>,path:string,token="operator-secret")=>a.handle(new Request(`http://localhost${path}`,{headers:token ? {authorization:`Bearer ${token}`} : {}}));
    const state=async()=>({ deliveries:await admin`SELECT id,state,lease_expires_at FROM queue.deliveries ORDER BY id`,head:await admin`SELECT last_position FROM audit.cursor WHERE workspace_id=${fixture.workspaceId}` });
    const before=await state(), first=app();
    expect((await request(first,"/health/operations","")).status).toBe(401);
    expect((await request(first,"/metrics","wrong")).status).toBe(401);
    const disabled=new Elysia().use(operationsRoute(pool,readOperationsConfig({}),new PrincipalAdmission(),new Map()));
    expect((await request(disabled,"/metrics")).status).toBe(503);
    const response=await request(first,"/health/operations"), body=await response.json();
    expect(response.status).toBe(503); expect(body.backup.ageSeconds.status).toBe("stale");
    expect(body.codes).toContain("backup_stale"); expect(body.codes).not.toContain("queue_expiry_stale");
    const metrics=await (await request(first,"/metrics")).text();
    expect(metrics).toContain('bp_signal_status{signal="backup.ageSeconds",status="stale"} 1');
    expect(await state()).toEqual(before);
    const [clock]=await admin`SELECT clock_timestamp() AS now`; await utimes(manifest,clock.now,clock.now);
    const refreshed=await (await request(app(),"/health/operations")).json();
    expect(refreshed.backup.ageSeconds.status).toBe("ok");
    expect(refreshed.codes).not.toContain("backup_stale");
    expect(await state()).toEqual(before);
    const settings=async()=> (await pool`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,current_setting('transaction_read_only') AS readonly`)[0];
    expect(await settings()).toEqual({statement:"7s",lock:"3s",readonly:"off"});
    await admin.begin(async tx=>{
      await tx`LOCK TABLE queue.queues IN ACCESS EXCLUSIVE MODE`;
      const failed=await (await request(app(),"/health/operations")).json();
      expect(failed.global.queues.expiredLeases.status).toBe("unknown");
      expect(await settings()).toEqual({statement:"7s",lock:"3s",readonly:"off"});
    });
  } finally { try { await pool.close(); await admin.close(); } finally { await rm(dir,{recursive:true,force:true}); } }
});

test("fresh install operations reports empty queues and initial disk growth as known", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    await sampleDisk(pool);
    const app = new Elysia().use(operationsRoute(pool, readOperationsConfig({ BP_OPERATIONS_TOKEN: "test" }), new PrincipalAdmission(), new Map()));
    const response = await app.handle(new Request("http://localhost/health/operations", { headers: { authorization: "Bearer test" } }));
    const body = await response.json();
    expect(body.coverage.workspaceCount).toBe("0");
    expect(body.global.queues.counts.status).toBe("ok");
    expect(body.events.newestAgeSeconds).toMatchObject({ value: 0, status: "ok" });
    expect(body.disk.growthBytesPerSecond).toMatchObject({ value: 0, status: "ok" });
    expect(body.codes).not.toContain("disk_growth_warming_up");
    const publicApp = await testApp(pool, { operations: readOperationsConfig({ BP_OPERATIONS_TOKEN: "test" }) });
    const ready = await publicApp.handle(new Request("http://localhost/health/ready"));
    expect(Object.keys(await ready.json()).sort()).toEqual(["enrollment", "problems", "status"]);
    const wrongBearer = await publicApp.handle(new Request("http://localhost/health/ready", { headers: { authorization: "Bearer not-the-token" } }));
    expect(Object.keys(await wrongBearer.json()).sort()).toEqual(["enrollment", "problems", "status"]);
  } finally { await pool.close(); }
});
