// Request-driven observations borrow one connection and leave its session settings unchanged.
import type { Enrollment } from "../auth/enrollment.ts";
import { opendir, open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname } from "node:path";
import { getSchemaValidator } from "elysia";
import type { Pool } from "./pool.ts";
import { databaseSchema, snapshotSchema, type Facts, type OperationsConfig, type Telemetry } from "./operations.ts";
const record = (v: unknown): v is Record<string,unknown> => typeof v==="object" && v!==null && !Array.isArray(v);
async function backupManifest(dir: string | undefined, systemId: string | undefined, signal: AbortSignal): Promise<Facts["backup"]> {
  if (!dir || !systemId) return null;
  signal.throwIfAborted();
  const root=await realpath(dir);
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
    const parent=await realpath(dirname(path));
    if (parent!==dirname(path) || (parent!==root && dirname(parent)!==root)) throw new Error("backup_path_outside_root");
    signal.throwIfAborted();
    const file = await open(join(parent,"manifest.json"),constants.O_RDONLY | constants.O_NOFOLLOW).catch((e: unknown)=>{
      if (record(e) && e.code==="ENOENT") return null; throw e;
    });
    if (!file) continue;
    try {
      signal.throwIfAborted();
      if (await realpath(dirname(path))!==parent) throw new Error("backup_path_changed");
      const stat=await file.stat();
      if (!stat.isFile() || stat.size>1048576) throw new Error("backup_manifest_invalid");
      const chunks: Buffer[]=[];
      for await (const chunk of file.createReadStream({start:0,end:1048576,autoClose:false,signal})) {
        signal.throwIfAborted();
        if (!Buffer.isBuffer(chunk)) throw new Error("backup_manifest_invalid");
        chunks.push(chunk);
      }
      const buffer=Buffer.concat(chunks);
      if (buffer.length>1048576) throw new Error("backup_manifest_overflow");
      const m: unknown=JSON.parse(buffer.toString());
      if (!record(m) || !record(m.before) || !record(m.after) || m.after.systemId!==systemId || m.before.systemId!==systemId
        || typeof m.name!=="string" || !/^(?:bp_[a-f0-9]{32}|[0-9]{8}T[0-9]{12}Z)$/.test(m.name) || typeof m.targetLsn!=="string" || !/^[0-9A-F]+\/[0-9A-F]+$/.test(m.targetLsn)
        || typeof m.segment!=="string" || !/^[0-9A-F]{24}$/.test(m.segment) || typeof m.after.timeline!=="number" || !Number.isInteger(m.after.timeline)
        || m.after.timeline<=0 || m.before.timeline!==m.after.timeline || parseInt(m.segment.slice(0,8),16)!==m.after.timeline
        || typeof m.after.postgres!=="string" || m.before.postgres!==m.after.postgres || typeof m.after.schema!=="number" || m.before.schema!==m.after.schema
        || typeof m.after.pgmq!=="string" || m.before.pgmq!==m.after.pgmq || !Array.isArray(m.before.heads) || !Array.isArray(m.after.heads)
        || ![...m.before.heads,...m.after.heads].every(h=>record(h) && typeof h.workspaceId==="string" && typeof h.head==="string" && /^\d+$/.test(h.head))) throw new Error("backup_manifest_invalid");
      const candidate={ completedAt:typeof m.completedAt === "string" ? m.completedAt : stat.mtime.toISOString(),restorePoint:{ name:m.name,lsn:m.targetLsn,timeline:m.after.timeline } };
      if (!latest || candidate.completedAt>latest.completedAt) latest=candidate;
    } finally { await file.close(); }
  }
  return latest;
}
export function operationsProbe(pool: Pool, config: OperationsConfig, enrollment?: Enrollment) {
  const snapshotValid=(value: unknown): value is NonNullable<Facts["snapshot"]> => getSchemaValidator(snapshotSchema,{normalize:false})?.Check(value) === true;
  const databaseValid=(value: unknown): value is NonNullable<Facts["database"]> => getSchemaValidator(databaseSchema,{normalize:false})?.Check(value) === true;
  let cache: { snapshot: Facts["snapshot"]; database: Facts["database"]; backup: Facts["backup"]; telemetry: Telemetry | null; started: number; clockAt: number } | undefined;
  let inFlight: Promise<NonNullable<typeof cache>> | undefined;
  const sample = async () => {
    if (cache && performance.now()-cache.started<5000) return cache;
    if (inFlight) return inFlight;
    const started=performance.now(), empty={ snapshot:null,database:null,backup:null,telemetry:null,started,clockAt:started };
    let expired=false;
    const pending = new Set<{ cancel(): unknown }>();
    const gather=async () => {
      const connection=await pool.reserve();
      const run=async <T>(query: import("bun").SQLQuery<T>) => {
        if (expired) throw new Error("operations_deadline");
        pending.add(query); try { return await query; } finally { pending.delete(query); }
      };
      try {
        if (expired) return empty;
        try {
          await run(connection`BEGIN READ ONLY`);
          await run(connection`SET LOCAL statement_timeout = '2000ms'`);
          await run(connection`SET LOCAL lock_timeout = '250ms'`);
          const [a]=await run(connection<{ value: unknown }[]>`SELECT queue.operational_snapshot() AS value`);
          const [b]=await run(connection<{ value: unknown }[]>`SELECT control.operational_database() AS value`);
          const [telemetry] = await run(connection<Telemetry[]>`
            SELECT pg_database_size(current_database())::float8 AS "databaseBytes",
              (SELECT blob_bytes::float8 FROM control.disk_samples ORDER BY observed_at DESC LIMIT 1) AS "blobBytes",
              (SELECT observed_at::text FROM control.disk_samples ORDER BY observed_at DESC LIMIT 1) AS "diskAt",
              (SELECT CASE WHEN count(*)<2 THEN NULL ELSE
                ((array_agg(database_bytes+blob_bytes ORDER BY observed_at DESC))[1]-(array_agg(database_bytes+blob_bytes ORDER BY observed_at))[1])::float8
                  / greatest(extract(epoch FROM max(observed_at)-min(observed_at)),1) END FROM control.disk_samples) AS growth,
              (SELECT max(occurred_at)::text FROM audit.events) AS "newestEvent",
              (SELECT max(occurred_at)::text FROM audit.events WHERE kind='retention.purged') AS "lastPurge"`);
          const clockAt=performance.now();
          const parse=(v: unknown): unknown => typeof v==="string" ? JSON.parse(v) : v;
          const snapshot=parse(a?.value), database=parse(b?.value);
          if (!snapshotValid(snapshot) || !databaseValid(database)) return empty;
          return { snapshot,database,backup:null,telemetry: telemetry ?? null,started,clockAt };
        } finally {
          // Cleanup must finish even after the probe deadline cancels a query.
          await connection`ROLLBACK`.catch(async (error: unknown)=>{ await connection.close(); throw error; });
        }
      } finally { connection.release(); }
    };
    let timer: ReturnType<typeof setTimeout>;
    const deadline=new Promise<typeof empty>(resolve=>{ timer=setTimeout(()=>{ expired=true; for (const query of pending) query.cancel(); resolve(empty); },3000); });
    const sql=gather().catch(()=>empty);
    const work=Promise.race([sql,deadline]).then(async sample=>{
      if (!sample.database) return sample;
      const controller=new AbortController();
      let fileTimer: ReturnType<typeof setTimeout> | undefined;
      const fileDeadline=new Promise<null>(resolve=>{ fileTimer=setTimeout(()=>{ controller.abort(); resolve(null); },1000); });
      try {
        const backup=await Promise.race([backupManifest(config.backupDir,sample.database.systemId,controller.signal).catch(()=>null),fileDeadline]);
        return {...sample,backup};
      } finally { clearTimeout(fileTimer); }
    });
    const response=work.then(value=>{ cache=value; return value; });
    inFlight=response;
    void sql.finally(()=>clearTimeout(timer));
    void Promise.all([sql,response]).finally(()=>{ inFlight=undefined; });
    return response;
  };
  return async () => ({ ...await sample(), enrollment: await enrollment?.observe() ?? { state: "unknown", capabilityFile: null, observedAt: null },
    signup: enrollment?.signup ?? { configured: "closed", effective: "closed" }, publicSignup: enrollment?.publicSignup ?? false } satisfies Partial<Facts> & { started: number; clockAt: number });
}
