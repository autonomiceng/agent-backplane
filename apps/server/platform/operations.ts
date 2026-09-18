// Pure operational policy shared by JSON and Prometheus; adapters supply observations and database time.
import { enrollmentState, signupSchema } from "../auth/enrollment-input.ts";
import type { EnrollmentObservation } from "../auth/enrollment.ts";
import { t } from "elysia";
import { poolLimit } from "./pool.ts";
export const statuses = ["ok", "warn", "unknown", "stale", "degraded"] as const;
const statusSchema = t.Union([t.Literal("ok"),t.Literal("warn"),t.Literal("unknown"),t.Literal("stale"),t.Literal("degraded")]);
const decimal = t.String({ pattern: "^[0-9]+$" });
export const deliveryStates = ["ready", "scheduled", "leased", "begun", "ambiguous", "effect-paused", "held", "dead-lettered"] as const;
const counts = t.Object(Object.fromEntries(deliveryStates.map(state=>[state,decimal])));
export const queueFact = t.Object({ counts: t.Record(t.String(),decimal), ready: t.Nullable(t.String()), expired: decimal, expiry: t.Nullable(t.String()) });
export const snapshotSchema = t.Object({ observedAt: t.String(), workspaceCount: decimal, queueCount: decimal,
  streamLimits: t.Array(t.Object({ workspaceId: t.String(), limit: t.Number() })),
  workspaces: t.Array(t.Object({ workspaceId: t.String(), limit: t.Number() })),
  queues: t.Array(t.Composite([queueFact,t.Object({ workspace_id: t.String(), queue: t.String() })])), global: queueFact,
  metrics: t.Array(t.Composite([queueFact,t.Object({ workspace_id: t.String() })])),
  quotas: t.Array(t.Object({ workspace_id: t.String(), resource: t.String(), exhausted: decimal })), quotaExhausted: decimal,
  restore: t.Nullable(t.Object({ active: t.Boolean(), epoch: t.Nullable(t.String()), released: decimal, pending: decimal })) });
export const databaseSchema = t.Object({ observedAt: t.String(), systemId: decimal, connections: decimal, maxConnections: decimal, reservedConnections: decimal,
  oldestTransaction: t.Nullable(t.String()), archiveEnabled: t.Boolean(), oldestPending: t.Nullable(t.String()), latestPending: t.Nullable(t.String()) });
const point = t.Object({ name: t.String(), lsn: t.String(), timeline: t.Number() });
const signal = <T extends import("elysia").TSchema>(value: T) => t.Object({ value: t.Nullable(value), observedAt: t.Nullable(t.String()), status: statusSchema, codes: t.Array(t.String()) });
const queueSignals = { counts: signal(counts), oldestReadyAgeSeconds: signal(t.Number()), expiredLeases: signal(decimal), oldestExpiredLeaseAgeSeconds: signal(t.Number()) };
export const operationsSchema = t.Object({ enrollment: t.Object({ state: enrollmentState, capabilityFile: t.Nullable(t.String()), observedAt: t.Nullable(t.String({ format: "date-time" })) }), signup: signupSchema, version: t.Literal(1), observedAt: t.Nullable(t.String()), status: t.Union([t.Literal("ok"),t.Literal("degraded")]), codes: t.Array(t.String()),
  coverage: t.Object({ workspaceCount: t.Nullable(decimal), listedWorkspaces: t.Number(), omittedQueues: t.Nullable(decimal) }),
  disk: t.Object({ databaseBytes: signal(t.Number()), blobBytes: signal(t.Number()), growthBytesPerSecond: signal(t.Number()) }),
  events: t.Object({ newestAgeSeconds: signal(t.Number()) }),
  retention: t.Object({ lastPurgeTimestampSeconds: signal(t.Number()) }),
  database: t.Object({ poolInUse: signal(t.Number()), poolWaiting: signal(t.Number()), poolLimit: signal(t.Number()), connections: signal(decimal), maxConnections: signal(decimal), reservedConnections: signal(decimal), oldestTransactionAgeSeconds: signal(t.Number()) }),
  global: t.Object({ queues: t.Object(queueSignals), quotas: t.Object({ exhaustedCounters: signal(decimal) }) }),
  queues: t.Array(t.Object({ workspaceId: t.String(), queue: t.String(), ...queueSignals })),
  streams: t.Array(t.Object({ workspaceId: t.String(), open: signal(t.Number()), limit: signal(t.Number()) })),
  admission: t.Object({ inUse: signal(t.Number()), waiters: signal(t.Number()), limit: signal(t.Number()), rejectedLastMinute: signal(t.Number()) }),
  quotas: t.Array(t.Object({ workspaceId: t.String(), resource: t.String(), exhaustedCounters: signal(decimal) })),
  backup: t.Object({ completedAt: signal(t.String()), restorePoint: signal(point), ageSeconds: signal(t.Number()), archiveLagSeconds: signal(t.Number()), latestPendingWal: signal(t.String()) }),
  restoreGate: t.Object({ active: signal(t.Boolean()), epoch: signal(t.String()), released: signal(decimal), pending: signal(decimal) }) });
export type OperationsConfig = ReturnType<typeof readOperationsConfig>;
export function readOperationsConfig(env: Record<string,string | undefined>) {
  const number = (key: string, fallback: number) => { const n = Number(env[`BP_OPERATIONS_${key}`] ?? fallback); if (!Number.isFinite(n) || n<=0) throw new Error(`invalid_operations_${key}`); return n; };
  return { token: env.BP_OPERATIONS_TOKEN, backupDir: env.BP_BACKUP_DIR, poolLimit, thresholds: {
    diskGrowth: number("DISK_GROWTH_MAX_BYTES_PER_SECOND",1048576), eventAge: number("EVENT_MAX_AGE_SECONDS",300), diskSample: number("DISK_SAMPLE_MAX_AGE_SECONDS",180), backup: number("BACKUP_MAX_AGE_SECONDS",86400), expiry: number("EXPIRED_LEASE_MAX_AGE_SECONDS",300), archive: number("ARCHIVE_MAX_LAG_SECONDS",300),
    ready: number("READY_WARN_SECONDS",300), transaction: number("TRANSACTION_WARN_SECONDS",30), utilization: number("UTILIZATION_WARN_RATIO",0.8), sample: number("SAMPLE_MAX_AGE_SECONDS",15) } };
}
export type Telemetry = { databaseBytes: number; blobBytes: number | null; growth: number | null; diskAt: string | null; newestEvent: string | null; lastPurge: string | null };
export type Facts = { pool?: { inUse: number; waiting: number } | null; telemetry?: Telemetry | null; enrollment?: EnrollmentObservation; signup?: { configured: "closed" | "open"; effective: "closed" | "open" }; publicSignup?: boolean; snapshot: typeof snapshotSchema.static | null; database: typeof databaseSchema.static | null;
  backup: { completedAt: string; restorePoint: typeof point.static } | null; elapsed: number;
  admission: { inUse: number; waiters: number; limit: number; rejectedLastMinute: number }; streams: Record<string,number> };
export function decideOperations(facts: Facts, databaseNow: number, config: OperationsConfig) {
  const { snapshot: s, database: d, backup: rawBackup } = facts, th = config.thresholds;
  const b=rawBackup && Number.isFinite(Date.parse(rawBackup.completedAt)) && Date.parse(rawBackup.completedAt)<=databaseNow ? rawBackup : null;
  const all: { status: typeof statuses[number]; codes: string[] }[] = [];
  const observedAt = d?.observedAt ?? s?.observedAt ?? null;
  const sig = <T>(value: T | null, at: string | null, code = "observation_unavailable", severity: typeof statuses[number] = "ok", reasons: string[] = [], emptyKnown = false, maxAge = th.sample) => {
    const valid = at !== null && Number.isFinite(Date.parse(at)) && Date.parse(at)<=databaseNow && Number.isFinite(databaseNow);
    const result = { value: valid ? value : null, observedAt: valid ? at : null,
      status: (value === null && !emptyKnown) || !valid ? "unknown" : severity, codes: (value === null && !emptyKnown) || !valid ? [code] : reasons } satisfies { value: T | null; observedAt: string | null; status: typeof statuses[number]; codes: string[] };
    if (valid && (value !== null || emptyKnown) && (facts.elapsed>=th.sample || (databaseNow-Date.parse(at))/1000>=maxAge)) { result.status="stale"; result.codes=[...result.codes,"sample_stale"]; }
    all.push(result); return result;
  };
  const age = (date: string | null | undefined, at: string | null, max: number, code: string, severity: "warn" | "stale") => {
    const n = date === null ? 0 : date === undefined ? NaN : (databaseNow-Date.parse(date))/1000;
    return sig(Number.isFinite(n) && n>=0 ? n : null,at,"observation_invalid",n>=max ? severity : "ok", n>=max ? [code] : []);
  };
  const warn = <T extends number|string|boolean>(value: T | null, at: string | null, bad: boolean, code: string) => sig(value,at,"observation_unavailable",bad ? "warn" : "ok",bad ? [code] : []);
  const queue = (q: typeof queueFact.static | null, at: string | null) => ({
    counts: warnCounts(q,at), oldestReadyAgeSeconds: age(q?.ready,at,th.ready,"queue_ready_old","warn"),
    expiredLeases: sig(q?.expired ?? null,at), oldestExpiredLeaseAgeSeconds: age(q?.expiry,at,th.expiry,"queue_expiry_stale","stale") });
  const warnCounts = (q: typeof queueFact.static | null, at: string | null) => {
    const value = q ? Object.fromEntries(deliveryStates.map(state=>[state,q.counts[state] ?? "0"])) : null;
    const codes = deliveryStates.filter(k=>["ambiguous","effect-paused","dead-lettered"].includes(k) && BigInt(q?.counts[k] ?? "0")>0n).map(k=>`queue_${k.replaceAll("-","_")}`);
    return sig(value,at,"snapshot_unavailable",codes.length ? "warn" : "ok",codes);
  };
  const global = { queues:queue(s?.global ?? null,s?.observedAt ?? null),
    quotas:{ exhaustedCounters:warn(s?.quotaExhausted ?? null,s?.observedAt ?? null,BigInt(s?.quotaExhausted ?? "0")>0n,"quota_exhausted") } };
  const capacity=d ? Number(d.maxConnections)-Number(d.reservedConnections) : NaN;
  const capacityValid=Number.isSafeInteger(capacity) && capacity>0;
  const a=facts.admission, live=Number.isFinite(databaseNow) ? new Date(databaseNow).toISOString() : null;
  const database = { poolInUse: warn(facts.pool?.inUse ?? null,live,(facts.pool?.inUse ?? 0)>=config.poolLimit*th.utilization,"pool_saturated"), poolWaiting: warn(facts.pool?.waiting ?? null,live,(facts.pool?.waiting ?? 0)>0,"pool_waiters"), poolLimit: sig(config.poolLimit,live),
    connections: sig(d?.connections ?? null,d?.observedAt ?? null,"observation_unavailable",
      !capacityValid ? "unknown" : Number(d?.connections)>=capacity*th.utilization ? "warn" : "ok",
      !capacityValid ? ["database_capacity_invalid"] : Number(d?.connections)>=capacity*th.utilization ? ["database_saturated"] : []),
    maxConnections:sig(d?.maxConnections ?? null,d?.observedAt ?? null),reservedConnections:sig(d?.reservedConnections ?? null,d?.observedAt ?? null), oldestTransactionAgeSeconds: age(d?.oldestTransaction,d?.observedAt ?? null,th.transaction,"transaction_old","warn") };
  const queues = s?.queues.map(q=>({ workspaceId:q.workspace_id,queue:q.queue,...queue(q,s.observedAt) })) ?? [];
  const metricQueues = s?.metrics.map(q=>({ workspaceId:q.workspace_id,...queue(q,s.observedAt) })) ?? [];
  for (const w of s?.streamLimits ?? []) warn(facts.streams[w.workspaceId] ?? 0,live,(facts.streams[w.workspaceId] ?? 0)>=w.limit*th.utilization,"streams_saturated");
  const streams = s?.workspaces.map(w=>({ workspaceId:w.workspaceId, open:warn(facts.streams[w.workspaceId] ?? 0,live,(facts.streams[w.workspaceId] ?? 0)>=w.limit*th.utilization,"streams_saturated"),limit:sig(w.limit,s.observedAt) })) ?? [];
  const admission = { inUse:warn(a.inUse,live,a.inUse>=a.limit*th.utilization,"admission_saturated"),waiters:warn(a.waiters,live,a.waiters>0,"admission_waiters"),limit:sig(a.limit,live),rejectedLastMinute:warn(a.rejectedLastMinute,live,a.rejectedLastMinute>0,"admission_rejected") };
  const quotas = s?.quotas.map(q=>({ workspaceId:q.workspace_id,resource:q.resource,exhaustedCounters:warn(q.exhausted,s.observedAt,BigInt(q.exhausted)>0n,"quota_exhausted") })) ?? [];
  const backup = { completedAt:sig(b?.completedAt ?? null,observedAt,"backup_unavailable"),restorePoint:sig(b?.restorePoint ?? null,observedAt,"backup_unavailable"),
    ageSeconds:age(b?.completedAt,observedAt,th.backup,"backup_stale","stale"),archiveLagSeconds:age(d?.archiveEnabled ? d.oldestPending : undefined,d?.observedAt ?? null,th.archive,"archive_stale","stale"),
    latestPendingWal:sig(d?.latestPending ?? null,d?.observedAt ?? null,"archive_unavailable","ok",[],d?.archiveEnabled===true) };
  const r=s?.restore, at=s?.observedAt ?? null;
  const restoreGate={ active:warn(r?.active ?? null,at,r?.active===true,"restore_gated"),epoch:sig(r?.epoch ?? null,at,"observation_unavailable","ok",[],r!==undefined && r!==null),released:sig(r?.released ?? null,at),pending:sig(r?.pending ?? null,at) };
  const enrollment = facts.enrollment ?? { state: "unknown", capabilityFile: null, observedAt: null };
  if (["unknown", "recovery_required"].includes(enrollment.state)) all.push({ status: "unknown", codes: [`enrollment_${enrollment.state}`] });
  if (facts.publicSignup) all.push({ status: "warn", codes: ["signup_open_public_origin"] });
  const telemetry = facts.telemetry, empty = s?.workspaceCount === "0";
  const disk = { databaseBytes: sig(telemetry?.databaseBytes ?? null,observedAt,"disk_unavailable"),
    blobBytes: sig(telemetry?.blobBytes ?? null,telemetry?.diskAt ?? null,"disk_sample_unavailable","ok",[],false,th.diskSample),
    growthBytesPerSecond: sig(telemetry?.growth ?? (empty && telemetry?.diskAt ? 0 : null),telemetry?.diskAt ?? null,"disk_growth_warming_up",
      (telemetry?.growth ?? 0)>=th.diskGrowth ? "warn" : "ok",(telemetry?.growth ?? 0)>=th.diskGrowth ? ["disk_growth_high"] : [],false,th.diskSample) };
  if (telemetry?.diskAt && databaseNow-Date.parse(telemetry.diskAt)>=th.diskSample*1000) all.push({ status: "degraded", codes: ["disk_sample_stale"] });
  const events = { newestAgeSeconds: age(telemetry?.newestEvent,observedAt,th.eventAge,"audit_event_old","warn") };
  const retention = { lastPurgeTimestampSeconds: sig(telemetry ? (telemetry.lastPurge ? Date.parse(telemetry.lastPurge)/1000 : 0) : null,observedAt,"retention_unavailable") };
  const worst=all.reduce<typeof statuses[number]>((a,b)=>statuses.indexOf(a)>statuses.indexOf(b.status) ? a : b.status,"ok");
  return { document:{ enrollment, signup: facts.signup ?? { configured: "closed", effective: "closed" }, version:1,observedAt,status: worst === "ok" ? "ok" : "degraded",codes:[...new Set(all.flatMap(s=>s.codes))],
    coverage:{ workspaceCount:s?.workspaceCount ?? null,listedWorkspaces:s?.workspaces.length ?? 0,omittedQueues:s ? String(BigInt(s.queueCount)-BigInt(s.queues.length)) : null },
    database,global,queues,streams,admission,quotas,backup,restoreGate,disk,events,retention } satisfies typeof operationsSchema.static, metricQueues };
}
