// Request-driven observations borrow one connection and leave its session settings unchanged.
import { unknownCapabilities, type CapabilitySampler } from "./capability-types.ts";
import type { Enrollment } from "../auth/enrollment.ts";
import { opendir, open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { getSchemaValidator } from "elysia";
import type { Pool } from "./pool.ts";
import { probeTransaction } from "./probe-transaction.ts";
import { databaseSchema, snapshotSchema, type Facts, type OperationsConfig, type Telemetry } from "./operations.ts";
const record = (v: unknown): v is Record<string,unknown> => typeof v==="object" && v!==null && !Array.isArray(v);
async function backupFile(path: string, root: string, limit: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const parent=await realpath(dirname(path));
  if (parent!==dirname(path) || (parent!==root && dirname(parent)!==root)) throw new Error("backup_path_outside_root");
  const file=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((e: unknown)=>{
    if (record(e) && e.code==="ENOENT") return null; throw e;
  });
  if (!file) return null;
  try {
    signal.throwIfAborted();
    if (await realpath(dirname(path))!==parent) throw new Error("backup_path_changed");
    const stat=await file.stat();
    if (!stat.isFile() || stat.size>limit) throw new Error("backup_file_invalid");
    const chunks: Buffer[]=[];
    for await (const chunk of file.createReadStream({start:0,end:limit,autoClose:false,signal})) {
      signal.throwIfAborted();
      if (!Buffer.isBuffer(chunk)) throw new Error("backup_file_invalid");
      chunks.push(chunk);
    }
    const buffer=Buffer.concat(chunks);
    if (buffer.length>limit) throw new Error("backup_file_overflow");
    const value: unknown=JSON.parse(buffer.toString());
    return {value,mtime:stat.mtime};
  } finally { await file.close(); }
}
async function backupManifest(dir: string | undefined, systemId: string | undefined, signal: AbortSignal): Promise<Facts["backup"]> {
  if (!dir || !systemId) return null;
  signal.throwIfAborted();
  const root=await realpath(dir);
  const receipt=await backupFile(join(root,"health.json"),root,4096,signal);
  if (receipt) {
    const m=receipt.value;
    if (!record(m) || Object.keys(m).sort().join()!=="completedAt,restorePoint,systemId,version" || m.version!==1 || m.systemId!==systemId
      || typeof m.completedAt!=="string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(m.completedAt) || !Number.isFinite(Date.parse(m.completedAt))
      || new Date(m.completedAt).toISOString().slice(0,19)!==m.completedAt.slice(0,19)
      || !record(m.restorePoint) || Object.keys(m.restorePoint).sort().join()!=="lsn,name,timeline"
      || typeof m.restorePoint.name!=="string" || !/^(?:bp_[a-f0-9]{32}|[0-9]{8}T[0-9]{12}Z)$/.test(m.restorePoint.name)
      || typeof m.restorePoint.lsn!=="string" || !/^[0-9A-F]+\/[0-9A-F]+$/.test(m.restorePoint.lsn)
      || typeof m.restorePoint.timeline!=="number" || !Number.isSafeInteger(m.restorePoint.timeline) || m.restorePoint.timeline<=0) throw new Error("backup_receipt_invalid");
    const checkpoint=await lstat(join(root,m.restorePoint.name));
    if (!checkpoint.isDirectory() || checkpoint.isSymbolicLink()) throw new Error("backup_receipt_checkpoint_missing");
    return {completedAt:m.completedAt,restorePoint:{name:m.restorePoint.name,lsn:m.restorePoint.lsn,timeline:m.restorePoint.timeline}};
  }
  const paths: string[] = [join(root,"manifest.json")];
  const direct=await lstat(paths[0] ?? "").catch((e: unknown)=>{ if (record(e) && e.code==="ENOENT") return null; throw e; });
  if (!direct) {
    const entries = await opendir(root);
    let count=0;
    for await (const entry of entries) {
      signal.throwIfAborted();
      if (++count>1024) throw new Error("backup_enumeration_overflow");
      if (entry.isDirectory()) paths.push(join(root,entry.name,"manifest.json"));
    }
  }
  let latest: Facts["backup"] = null;
  for (const path of paths) {
    signal.throwIfAborted();
    const file=await backupFile(path,root,1048576,signal);
    if (!file) continue;
    const m=file.value;
    if (!record(m) || !record(m.before) || !record(m.after) || m.after.systemId!==systemId || m.before.systemId!==systemId
      || typeof m.name!=="string" || !/^(?:bp_[a-f0-9]{32}|[0-9]{8}T[0-9]{12}Z)$/.test(m.name) || typeof m.targetLsn!=="string" || !/^[0-9A-F]+\/[0-9A-F]+$/.test(m.targetLsn)
      || typeof m.segment!=="string" || !/^[0-9A-F]{24}$/.test(m.segment) || typeof m.after.timeline!=="number" || !Number.isInteger(m.after.timeline)
      || m.after.timeline<=0 || m.before.timeline!==m.after.timeline || parseInt(m.segment.slice(0,8),16)!==m.after.timeline
      || typeof m.after.postgres!=="string" || m.before.postgres!==m.after.postgres || typeof m.after.schema!=="number" || m.before.schema!==m.after.schema
      || typeof m.after.pgmq!=="string" || m.before.pgmq!==m.after.pgmq || !Array.isArray(m.before.heads) || !Array.isArray(m.after.heads)
      || ![...m.before.heads,...m.after.heads].every(h=>record(h) && typeof h.workspaceId==="string" && typeof h.head==="string" && /^\d+$/.test(h.head))) throw new Error("backup_manifest_invalid");
    const candidate={ completedAt:typeof m.completedAt === "string" ? m.completedAt : file.mtime.toISOString(),restorePoint:{ name:m.name,lsn:m.targetLsn,timeline:m.after.timeline } };
    if (!latest || candidate.completedAt>latest.completedAt) latest=candidate;
  }
  return latest;
}
export function operationsProbe(pool: Pool, config: OperationsConfig, enrollment?: Enrollment, capabilities?: CapabilitySampler) {
  const snapshotValid=(value: unknown): value is NonNullable<Facts["snapshot"]> => getSchemaValidator(snapshotSchema,{normalize:false})?.Check(value) === true;
  const databaseValid=(value: unknown): value is NonNullable<Facts["database"]> => getSchemaValidator(databaseSchema,{normalize:false})?.Check(value) === true;
  let cache: { snapshot: Facts["snapshot"]; database: Facts["database"]; backup: Facts["backup"]; telemetry: Telemetry | null; started: number; clockAt: number } | undefined;
  let inFlight: Promise<NonNullable<typeof cache>> | undefined;
  const sample = async () => {
    if (cache && performance.now()-cache.started<5000) return cache;
    if (inFlight) return inFlight;
    const started=performance.now(), empty={ snapshot:null,database:null,backup:null,telemetry:null,started,clockAt:started };
    const gather=() => probeTransaction(pool, 3000, async connection => {
      await connection`SET LOCAL statement_timeout = '2000ms'`;
      await connection`SET LOCAL lock_timeout = '250ms'`;
      const [a]=await connection<{ value: unknown }[]>`SELECT queue.operational_snapshot() AS value`;
      const [b]=await connection<{ value: unknown }[]>`SELECT control.operational_database() AS value`;
      const [telemetry] = await connection<Telemetry[]>`
        SELECT pg_database_size(current_database())::float8 AS "databaseBytes",
          (SELECT blob_bytes::float8 FROM control.disk_samples ORDER BY observed_at DESC LIMIT 1) AS "blobBytes",
          (SELECT observed_at::text FROM control.disk_samples ORDER BY observed_at DESC LIMIT 1) AS "diskAt",
          (SELECT CASE WHEN count(*)<2 THEN NULL ELSE
            ((array_agg(database_bytes+blob_bytes ORDER BY observed_at DESC))[1]-(array_agg(database_bytes+blob_bytes ORDER BY observed_at))[1])::float8
              / greatest(extract(epoch FROM max(observed_at)-min(observed_at)),1) END FROM control.disk_samples) AS growth,
          (SELECT max(occurred_at)::text FROM audit.events) AS "newestEvent",
          (SELECT max(occurred_at)::text FROM audit.events WHERE kind='retention.purged') AS "lastPurge"`;
      const clockAt=performance.now();
      const parse=(v: unknown): unknown => typeof v==="string" ? JSON.parse(v) : v;
      const snapshot=parse(a?.value), database=parse(b?.value);
      if (!snapshotValid(snapshot) || !databaseValid(database)) return empty;
      return { snapshot,database,backup:null,telemetry: telemetry ?? null,started,clockAt };
    });
    const work=gather().catch(()=>empty).then(async sample=>{
      if (!sample.database) return sample;
      const controller=new AbortController();
      let fileTimer: ReturnType<typeof setTimeout> | undefined;
      const fileDeadline=new Promise<null>(resolve=>{ fileTimer=setTimeout(()=>{ controller.abort(); resolve(null); },1000); });
      try {
        const backup=await Promise.race([backupManifest(config.backupDir,sample.database.systemId,controller.signal).catch(()=>null),fileDeadline]);
        return {...sample,backup};
      } finally { clearTimeout(fileTimer); }
    });
    const response=work.then(value=>{ cache=value; return value; }).finally(()=>{ inFlight=undefined; });
    inFlight=response;
    return response;
  };
  return async () => {
    const [observation, capabilityObservation] = await Promise.all([sample(), capabilities?.().catch(() => unknownCapabilities()) ?? unknownCapabilities()]);
    return ({ ...observation, capabilities: capabilityObservation, enrollment: await enrollment?.observe() ?? { state: "unknown", capabilityFile: null, observedAt: null },
    signup: enrollment?.signup ?? { configured: "closed", effective: "closed" }, publicSignup: enrollment?.publicSignup ?? false } satisfies Partial<Facts> & { started: number; clockAt: number });
  };
}
