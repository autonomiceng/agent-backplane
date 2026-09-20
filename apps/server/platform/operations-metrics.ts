import { capabilityStates } from "./capability-types.ts";
// Fixed gauge families; queue labels aggregate every Queue in a listed Workspace.
import { type decideOperations, statuses, deliveryStates } from "./operations.ts";
export function operationsMetrics(result: ReturnType<typeof decideOperations>): string {
  const d=result.document, lines: string[]=[], declared=new Set<string>();
  const escape=(s:string)=>s.replaceAll("\\","\\\\").replaceAll("\n","\\n").replaceAll('"','\\"');
  const families = ["pool_in_use","pool_waiting","pool_limit","database_connections","database_max_connections","database_reserved_connections","database_oldest_transaction_age_seconds",
    "queue_deliveries","queue_oldest_ready_age_seconds","queue_expired_leases","queue_oldest_expired_lease_age_seconds",
    "global_queue_deliveries","global_queue_oldest_ready_age_seconds","global_queue_expired_leases","global_queue_oldest_expired_lease_age_seconds","global_quota_exhausted_counters",
    "streams_open","streams_limit","admission_in_use","admission_waiters","admission_limit","admission_rejected_last_minute",
    "quota_exhausted_counters","backup_completed_timestamp_seconds","backup_age_seconds","archive_lag_seconds","restore_gate_active",
    "restore_workspaces","operations_status","signal_status","signal_observed_timestamp_seconds"];
  for (const name of families) { lines.push(`# HELP bp_${name} Backplane ${name.replaceAll("_"," ")}.`,`# TYPE bp_${name} gauge`); declared.add(name); }
  const emit=(name:string,value:number|string|null,labels:Record<string,string>={})=>{
    if (!declared.has(name)) { lines.push(`# HELP bp_${name} Backplane ${name.replaceAll("_"," ")}.`,`# TYPE bp_${name} gauge`); declared.add(name); }
    lines.push(`bp_${name}${Object.keys(labels).length ? `{${Object.entries(labels).map(([k,v])=>`${k}="${escape(v)}"`).join(",")}}` : ""} ${value ?? "NaN"}`);
  };
  const gauge=(name:string,s:{ value:unknown; observedAt:string|null; status:string },labels:Record<string,string>={},value: number|string|null = typeof s.value==="number" || typeof s.value==="string" ? s.value : typeof s.value==="boolean" ? Number(s.value) : null)=>{
    emit(name,value,labels);
  };
  for (const [name,s] of Object.entries(d.database)) gauge(({ poolInUse:"pool_in_use",poolWaiting:"pool_waiting",poolLimit:"pool_limit",connections:"database_connections",maxConnections:"database_max_connections",reservedConnections:"database_reserved_connections",oldestTransactionAgeSeconds:"database_oldest_transaction_age_seconds" })[name] ?? name,s);
  gauge("disk_database_bytes",d.disk.databaseBytes); gauge("disk_blob_bytes",d.disk.blobBytes);
  gauge("disk_growth_bytes_per_second",d.disk.growthBytesPerSecond);
  gauge("event_newest_age_seconds",d.events.newestAgeSeconds);
  gauge("retention_last_purge_timestamp_seconds",d.retention.lastPurgeTimestampSeconds);
  const queues=(q: typeof d.global.queues,prefix: string,labels: Record<string,string>)=>{
    for (const state of deliveryStates) emit(`${prefix}queue_deliveries`,q.counts.value?.[state] ?? null,{...labels,state});
    gauge(`${prefix}queue_oldest_ready_age_seconds`,q.oldestReadyAgeSeconds,labels); gauge(`${prefix}queue_expired_leases`,q.expiredLeases,labels); gauge(`${prefix}queue_oldest_expired_lease_age_seconds`,q.oldestExpiredLeaseAgeSeconds,labels);
  };
  queues(d.global.queues,"global_",{});
  gauge("global_quota_exhausted_counters",d.global.quotas.exhaustedCounters);
  for (const q of result.metricQueues) queues(q,"",{workspace_id:q.workspaceId});
  for (const s of d.streams) { gauge("streams_open",s.open,{ workspace_id:s.workspaceId }); gauge("streams_limit",s.limit,{ workspace_id:s.workspaceId }); }
  gauge("admission_in_use",d.admission.inUse); gauge("admission_waiters",d.admission.waiters); gauge("admission_limit",d.admission.limit); gauge("admission_rejected_last_minute",d.admission.rejectedLastMinute);
  for (const q of d.quotas) gauge("quota_exhausted_counters",q.exhaustedCounters,{ workspace_id:q.workspaceId,resource:q.resource });
  gauge("checkpoint_timestamp_seconds",d.backup.completedAt,{},d.backup.completedAt.value ? Date.parse(d.backup.completedAt.value)/1000 : null);
  gauge("backup_completed_timestamp_seconds",d.backup.completedAt,{},d.backup.completedAt.value ? Date.parse(d.backup.completedAt.value)/1000 : null);
  gauge("backup_age_seconds",d.backup.ageSeconds); gauge("archive_lag_seconds",d.backup.archiveLagSeconds); gauge("restore_gate_active",d.restoreGate.active);
  gauge("restore_workspaces",d.restoreGate.released,{state:"released"}); gauge("restore_workspaces",d.restoreGate.pending,{state:"pending"});
  for (const [capability, observation] of Object.entries(d.capabilities)) {
    for (const state of capabilityStates) emit("capability_state", Number(observation.state === state), { capability, state });
    emit("capability_observed_timestamp_seconds", observation.observedAt ? Date.parse(observation.observedAt) / 1000 : null, { capability });
  }
  for (const status of statuses) emit("operations_status",Number(d.status===status),{status});
  const walk=(v:unknown,path:string)=>{
    if (!v || typeof v!=="object") return;
    if ("status" in v && "value" in v && "observedAt" in v) {
      for (const status of statuses) emit("signal_status",Number(v.status===status),{signal:path,status});
      emit("signal_observed_timestamp_seconds",typeof v.observedAt==="string" ? Date.parse(v.observedAt)/1000 : null,{signal:path}); return;
    }
    if (Array.isArray(v)) return;
    for (const [key,value] of Object.entries(v)) walk(value,path ? `${path}.${key}` : key);
  };
  walk(d,"");
  for (const [name,values] of [["queues",result.metricQueues],["streams",d.streams],["quotas",d.quotas]] as const) {
    for (const value of values) walk(value,`${name}.${value.workspaceId}${"resource" in value ? `.${value.resource}` : ""}`);
  }
  return lines.join("\n")+"\n";
}
