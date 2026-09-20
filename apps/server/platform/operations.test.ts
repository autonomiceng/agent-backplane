// The two S27 scenarios cover policy and adapters without extra test cases.
import { expect, test } from "bun:test";
import { operationsMetrics } from "./operations-metrics.ts";
import { decideOperations, readOperationsConfig, type Facts } from "./operations.ts";

test("Missing evidence or threshold equality produces ok", () => {
  const now=Date.parse("2026-09-14T12:00:00Z"), at=new Date(now).toISOString();
  const config=readOperationsConfig({}), q={ counts:{},ready:null,expired:"0",expiry:null };
  const facts={ capabilities: { files: { state: "healthy", observedAt: at, backend: "filesystem" }, functions: { state: "disabled", observedAt: null, backend: null } }, pool:{inUse:0,waiting:0},telemetry:{databaseBytes:100,blobBytes:0,growth:0,diskAt:at,newestEvent:at,lastPurge:at}, enrollment: { state: "claimed", capabilityFile: null, observedAt: at }, elapsed:0,backup:{ completedAt:new Date(now-1000).toISOString(),restorePoint:{ name:"bp_test",lsn:"0/1",timeline:1 } },
    database:{ observedAt:at,systemId:"1",connections:"1",maxConnections:"105",reservedConnections:"5",oldestTransaction:null,archiveEnabled:true,oldestPending:null,latestPending:null },
    snapshot:{ observedAt:at,workspaceCount:"0",queueCount:"0",streamLimits:[],workspaces:[],queues:[],global:q,metrics:[],quotas:[],quotaExhausted:"0",restore:{ active:false,epoch:null,released:"0",pending:"0" } },
    admission:{ inUse:0,waiters:0,limit:6,rejectedLastMinute:0 },streams:{} } satisfies Facts;
  const decide=(f:Facts,clock=now)=>decideOperations(f,clock,config).document;
  expect(decide(facts).status).toBe("ok");
  expect(decide(facts).codes).toEqual([]);
  const missingCapabilities = decide({ ...facts, capabilities: { ...facts.capabilities, files: { state: "unknown", observedAt: null, backend: null } } });
  expect(missingCapabilities.status).toBe("degraded");
  expect(missingCapabilities.codes).toEqual(["files_unknown"]);
  const failedCapabilities = decideOperations({ ...facts, capabilities: { ...facts.capabilities, functions: { state: "unavailable", observedAt: at, backend: null } } }, now, config);
  expect(failedCapabilities.document.status).toBe("degraded");
  expect(failedCapabilities.document.codes).toEqual(["functions_unavailable"]);
  expect(operationsMetrics(failedCapabilities)).toContain('bp_capability_state{capability="functions",state="unavailable"} 1');
  expect(operationsMetrics(decideOperations(facts, now, config))).toContain('bp_capability_state{capability="functions",state="disabled"} 1');
  expect(decide(facts).backup.archiveLagSeconds.value).toBe(0);
  expect(decide({...facts,database:{...facts.database,connections:"79"}}).database.connections.status).toBe("ok");
  const saturated=decide({...facts,database:{...facts.database,connections:"80"}});
  expect(saturated.database.connections.status).toBe("warn");
  expect(saturated.database.connections.codes).toEqual(["database_saturated"]);
  expect(decide({...facts,database:{...facts.database,maxConnections:"5"}}).database.connections.status).toBe("unknown");
  const old={ ...facts,backup:{ ...facts.backup,completedAt:new Date(now-config.thresholds.backup*1000).toISOString() } };
  expect(decide(old).backup.ageSeconds.status).toBe("stale");
  expect(decide(old).status).toBe("degraded");
  expect(decide({...facts,backup:null}).backup.ageSeconds.status).toBe("unknown");
  expect(decide({...facts,backup:{...facts.backup,completedAt:new Date(now+1000).toISOString()}}).backup.completedAt.value).toBeNull();
  expect(decide({...facts,database:null,snapshot:null,backup:null}).status).toBe("degraded");
  const boundary={...facts,snapshot:{...facts.snapshot,global:{...q,expiry:new Date(now-config.thresholds.expiry*1000).toISOString(),expired:"1"}}};
  expect(decide(boundary).codes).toContain("queue_expiry_stale");
  const omitted={...boundary,snapshot:{...boundary.snapshot,workspaceCount:"101",queueCount:"1",quotaExhausted:"2"}};
  const global=decideOperations(omitted,now,config), metrics=operationsMetrics(global);
  expect(global.document.queues).toEqual([]);
  expect(global.document.global.queues.oldestExpiredLeaseAgeSeconds.status).toBe("stale");
  expect(global.document.global.quotas.exhaustedCounters).toMatchObject({value:"2",status:"warn"});
  expect(metrics).toContain("bp_global_queue_expired_leases 1\n");
  expect(metrics).toContain("bp_global_quota_exhausted_counters 2\n");
  expect(metrics).toContain('bp_signal_status{signal="global.queues.oldestExpiredLeaseAgeSeconds",status="stale"} 1');
  expect(decide({...facts,snapshot:null}).global.queues.expiredLeases.status).toBe("unknown");
  expect(decide({...facts,database:{...facts.database,oldestPending:new Date(now-config.thresholds.archive*1000).toISOString()}}).backup.archiveLagSeconds.status).toBe("stale");
  expect(decide({...facts,snapshot:{...facts.snapshot,global:{...q,ready:new Date(now-config.thresholds.ready*1000).toISOString()}}}).codes).toContain("queue_ready_old");
  expect(decide({...facts,database:{...facts.database,oldestTransaction:new Date(now-config.thresholds.transaction*1000).toISOString()}}).codes).toContain("transaction_old");
  expect(decide({...facts,admission:{...facts.admission,inUse:8,limit:10}}).codes).toContain("admission_saturated");
  expect(decide({...facts,elapsed:config.thresholds.sample},now+config.thresholds.sample*1000).codes).toContain("sample_stale");
  const near={...facts,backup:{...facts.backup,completedAt:new Date(now-(config.thresholds.backup-1)*1000).toISOString()}};
  expect(decide(near).backup.ageSeconds.status).toBe("ok");
  expect(decide({...near,elapsed:1},now+1000).backup.ageSeconds.status).toBe("stale");
});
