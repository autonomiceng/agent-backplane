// One database scenario observes both defects independently without dispatching or emitting audit events.
import { createPool } from "./pool.ts";
import { sampleDisk } from "./disk-sampler.ts";
import { expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm, utimes, writeFile, readFile, stat, symlink, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Elysia } from "elysia";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { advanceDeliveryClock, recoveryFixture, testApp } from "../testing/session.ts";
import { PrincipalAdmission } from "./principal-admission.ts";
import { operationsProbe } from "./operations-probe.ts";
import { operationsRoute } from "./operations-route.ts";
import { readOperationsConfig } from "./operations.ts";

test("Stale backup and undetected expired leases appear healthy", async () => {
  const url=await migratedDatabase(), pool=new SQL({url,max:1}), admin=new SQL({url:adminUrl(url),max:1});
  const dir=await mkdtemp(join(tmpdir(),"bp-operations-"));
  try {
    await pool`SET statement_timeout = '7s'`;
    await pool`SET lock_timeout = '3s'`;
    const fixture=await recoveryFixture(pool);
    expect((await fixture.send("leased")).status).toBe(201);
    const claimed=await fixture.claim(); expect(claimed.status).toBe(200);
    const delivery=await claimed.json();
    expect((await fixture.send("ready")).status).toBe(201);
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
    expect(body.queues[0].counts.value.ready).toBe("1");
    const metrics=await (await request(first,"/metrics")).text();
    expect(metrics).toContain('bp_signal_status{signal="backup.ageSeconds",status="stale"} 1');
    expect(metrics).toContain(`bp_queue_deliveries{workspace_id="${fixture.workspaceId}",state="ready"} 1`);
    expect(await state()).toEqual(before);
    await advanceDeliveryClock(admin,{workspaceId:fixture.workspaceId,principalId:fixture.principalId,runId:fixture.runId},delivery.deliveryId,"leased");
    const [clock]=await admin`SELECT clock_timestamp() AS now`; await utimes(manifest,clock.now,clock.now);
    const expired=await state(), second=app(), expiryResponse=await request(second,"/health/operations"), expiry=await expiryResponse.json();
    expect(expiryResponse.status).toBe(503); expect(expiry.backup.ageSeconds.status).toBe("ok");
    expect(expiry.codes).toContain("queue_expiry_stale"); expect(expiry.codes).not.toContain("backup_stale");
    expect(expiry.queues[0].expiredLeases.value).toBe("1");
    const expiryMetrics=await (await request(second,"/metrics")).text();
    expect(expiryMetrics).toContain(`bp_queue_expired_leases{workspace_id="${fixture.workspaceId}"} 1`);
    expect(expiryMetrics).toContain('bp_operations_status{status="degraded"} 1');
    expect(await state()).toEqual(expired);
    expect(expiry.global.queues.expiredLeases.value).toBe("1");
    expect(expiryMetrics).toContain("bp_global_queue_expired_leases 1\n");
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

test("public checkpoint receipt reports only its database and rejects malformed or unsafe paths", async () => {
  const url=await migratedDatabase(), pool=createPool(url), admin=new SQL({url:adminUrl(url),max:1});
  const dir=await mkdtemp(join(tmpdir(),"bp-checkpoint-health-")), name=`bp_${"b".repeat(32)}`, health=join(dir,"health.json");
  try {
    const [identity]=await admin`SELECT (pg_control_system()).system_identifier::text AS id`;
    const snapshot={systemId:identity.id,timeline:1,postgres:"180000",schema:32,pgmq:"1",heads:[]};
    const doc={version:1,name,before:snapshot,after:snapshot,targetLsn:"0/1",segment:"000000010000000000000001",
      storage:{bucket:"private-bucket"},credentials:{salt:"private-salt",digest:"private-commitment"}};
    const child=Bun.spawn(["python3","-B","-c",`import json,sys
from pathlib import Path
from checkpoint import publish_checkpoint
root=Path(sys.argv[1]); doc=json.loads(sys.argv[2]); dest=root/doc['name']; dest.mkdir()
publish_checkpoint(dest,doc)
`,dir,JSON.stringify(doc)],{cwd:new URL("../../../scripts/",import.meta.url).pathname,stdout:"pipe",stderr:"pipe"});
    const stderr=await new Response(child.stderr).text();
    expect(await child.exited,stderr).toBe(0);
    expect((await stat(join(dir,name))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir,name,"manifest.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(health)).mode & 0o777).toBe(0o644);
    const receipt=JSON.parse(await readFile(health,"utf8")), manifest=JSON.parse(await readFile(join(dir,name,"manifest.json"),"utf8"));
    expect(receipt).toEqual({version:1,systemId:identity.id,completedAt:manifest.completedAt,restorePoint:{name,lsn:"0/1",timeline:1}});
    expect(manifest.credentials).toEqual(doc.credentials);
    const observe=async()=> (await operationsProbe(pool,readOperationsConfig({BP_BACKUP_DIR:dir}))()).backup;
    expect(await observe()).toEqual({completedAt:receipt.completedAt,restorePoint:receipt.restorePoint});
    await writeFile(health,JSON.stringify({...receipt,systemId:"wrong-database"}));
    expect(await observe()).toBeNull();
    await writeFile(health,JSON.stringify({...receipt,completedAt:"not-a-date"}));
    expect(await observe()).toBeNull();
    await writeFile(health,JSON.stringify({...receipt,restorePoint:{...receipt.restorePoint,name:"../outside"}}));
    expect(await observe()).toBeNull();
    await writeFile(health," ".repeat(4097));
    expect(await observe()).toBeNull();
    await rm(health); await symlink(join(dir,name,"manifest.json"),health);
    expect(await observe()).toBeNull();
    await rm(health); await writeFile(health,JSON.stringify(receipt));
    await rename(join(dir,name),join(dir,"saved-checkpoint"));
    expect(await observe()).toBeNull();
    await symlink(join(dir,"saved-checkpoint"),join(dir,name));
    expect(await observe()).toBeNull();
    await rm(join(dir,name)); await rename(join(dir,"saved-checkpoint"),join(dir,name));
    await rm(health);
    expect(await observe()).toEqual({completedAt:receipt.completedAt,restorePoint:receipt.restorePoint});
  } finally { await pool.close(); await admin.close(); await rm(dir,{recursive:true,force:true}); }
});

test("reconciliation deadline releases its database lease and root readiness failures have stable errors", async () => {
  const url=adminUrl(await migratedDatabase()), admin=new SQL({url,max:1});
  const dir=await mkdtemp(join(tmpdir(),"bp-checkpoint-deadline-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let ready=false, deny=false;
  const server=Bun.serve({port:0,hostname:"127.0.0.1",fetch(request) {
    const path=new URL(request.url).pathname;
    if (path==="/health/ready") return new Response(null,{status:ready ? 200 : 503});
    if (!ready || deny) return new Response("private diagnostic",{status:403});
    if (path.startsWith("/rustfs/admin/")) return Response.json({parentUser:"root",impliedPolicy:false});
    return new Response("<VersioningConfiguration/>");
  }});
  try {
    await admin.begin(async tx=>{
      await tx`LOCK TABLE control.blobs IN ACCESS EXCLUSIVE MODE`;
      const started=performance.now();
      const inspection=Bun.spawn(["bun","apps/server/blobs/storage-admin.ts","reconcile","--fenced","--checkpoint","capture-1"],{
        cwd:new URL("../../../",import.meta.url).pathname,stdout:"pipe",stderr:"pipe",
        env:{...Bun.env,BP_ADMIN_DATABASE_URL:url,BP_STORAGE_ADMIN_URL_FILE:"",BP_DATA_DIR:dir,BP_BLOB_BACKEND:"filesystem",BP_STARTUP_VERIFY_TIMEOUT:"1"},
      });
      child=inspection;
      let leaseObserved=false;
      while (performance.now()-started<1500 && inspection.exitCode===null) {
        const [lock]=await tx`SELECT EXISTS(SELECT FROM pg_locks WHERE locktype='advisory'
          AND classid=112933 AND objid=32 AND objsubid=2 AND granted
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS held`;
        if (lock.held) { leaseObserved=true; break; }
        await Bun.sleep(10);
      }
      expect(leaseObserved).toBe(true);
      expect(await inspection.exited).toBe(1);
      expect(performance.now()-started).toBeLessThan(4000);
      expect(await new Response(inspection.stderr).text()).toBe('{"error":"blob_binding_inspection_timeout"}\n');
      let available=false;
      const releaseDeadline=performance.now()+1500;
      while (performance.now()<releaseDeadline) {
        const [lease]=await tx`SELECT pg_try_advisory_lock(112933,32) AS available`;
        if (lease.available) { available=true; break; }
        await Bun.sleep(10);
      }
      expect(available).toBe(true);
      await tx`SELECT pg_advisory_unlock(112933,32)`;
    });
    const helper=join(dir,"proof.js");
    await writeFile(helper,(await Bun.file(new URL("../../../scripts/s3-checkpoint-proof.js",import.meta.url)).text()).replaceAll("http://rustfs:9000",server.url.origin));
    const proof=async()=>{
      const worker=Bun.spawn(["bun",helper],{stdout:"pipe",stderr:"pipe",env:{...Bun.env,
        BP_RUSTFS_ROOT_USER:"root",BP_RUSTFS_ROOT_PASSWORD:"private-root",BP_BLOB_S3_ACCESS_KEY:"scoped",BP_BLOB_S3_BUCKET:"bucket"}});
      child=worker;
      const exit=await worker.exited;
      return {exit,error:await new Response(worker.stderr).text()};
    };
    const transition=setTimeout(()=>{ready=true;},200);
    try { expect(await proof()).toEqual({exit:0,error:""}); } finally { clearTimeout(transition); }
    deny=true;
    expect(await proof()).toEqual({exit:1,error:"checkpoint_proof_authentication\n"});
    ready=false;
    const started=performance.now();
    expect(await proof()).toEqual({exit:1,error:"checkpoint_proof_readiness\n"});
    expect(performance.now()-started).toBeLessThan(34000);
  } finally {
    if (child && child.exitCode===null) { child.kill(); await child.exited; }
    await server.stop(true); await admin.close(); await rm(dir,{recursive:true,force:true});
  }
},45000);
