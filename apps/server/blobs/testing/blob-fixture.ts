// Shared real-Postgres fixture and storage fault boundaries for the three blob scenarios.
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool } from "../../platform/pool.ts";
import { migratedDatabase } from "../../testing/postgres.ts";
import { principalFixture, issueKey, createRun } from "../../testing/session.ts";
import { type RunTransaction } from "../../runs/with-run-context.ts";
import type { AuditPage } from "../../events/read-audit-input.ts";
import type { blobResponse } from "../put-blob-input.ts";
import { filesystemStore } from "../filesystem-store.ts";
import { cleanupBlobs } from "../sweep-blobs.ts";
import { type BlobStore } from "../blob-store.ts";

export type Metadata = typeof blobResponse.static;
export async function fixture(storage?: BlobStore, cleanupStorage = true) {
  const database = createPool(await migratedDatabase()), dataDir = await mkdtemp(join(tmpdir(), "bp-blobs-"));
  const appCleanups: (() => Promise<void>)[] = [];
  const release = async () => {
    const results = await Promise.allSettled([
      database.close(), rm(dataDir, { recursive: true, force: true }), ...appCleanups.map(cleanup => cleanup()),
    ]);
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  };
  try {
    const disk = storage ?? filesystemStore(dataDir), staged = new Set<string>();
    let failStage = false, failPromotion = false, failRemove = false, uncertain = false, loseCommit = false, unknownCommit = false, failRecheck = false, deleteCommit = "";
    const begin = database.begin.bind(database);
    // Inject commit-boundary failures around real PostgreSQL transactions; no query results are fabricated.
    const pool = new Proxy(database, { get(target, property, receiver) {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return async (fn: (tx: RunTransaction) => Promise<unknown>) => {
        if (failRecheck) { failRecheck = false; throw new Error("recheck_database_unavailable"); }
        let fault = "";
        const result = await begin(async (tx) => {
          const value = await fn(tx);
          if (typeof value === "object" && value !== null && "ok" in value && value.ok === true && "value" in value && value.value === null) {
            fault = deleteCommit; deleteCommit = "";
            if (fault === "rollback") throw new Error("commit_connection_lost");
          }
          return value;
        });
        if (loseCommit || fault === "committed") { loseCommit = false; failRecheck = unknownCommit; unknownCommit = false; throw new Error("commit_connection_lost"); }
        return result;
      };
    } });
    const store: BlobStore = {
      ...disk,
      async stage(w, id, bytes) { staged.add(id); await disk.stage(w, id, bytes); if (failStage) throw new Error("stage_failed"); },
      async promote(w, id, bytes) {
        await disk.promote(w, id, bytes);
        if (failPromotion) throw new Error("promotion_failed");
        if (uncertain) { uncertain = false; loseCommit = true; }
      },
      async remove(w, ref) { if (failRemove) throw new Error("physical_delete_failed"); await disk.remove(w, ref); },
    };
    const f = await principalFixture(pool, { blobStore: store }, cleanup => appCleanups.push(cleanup));
    const key = await issueKey(f.app, f.cookie, f.workspaceId, f.principalId), runId = await createRun(f.app, key, f.workspaceId);
    const base = `http://localhost/api/v1/workspaces/${f.workspaceId}`;
    const headers = { authorization: `Bearer ${key}`, "x-backplane-run": runId, "content-type": "application/octet-stream" };
    const userHeaders = { cookie: f.cookie, origin: "http://localhost", "content-type": "application/json" };
    const put = (key: string, bytes: BodyInit = "private bytes", actor = headers) => f.app.handle(new Request(`${base}/blobs?key=${key}`, { method: "POST", headers: actor, body: bytes }));
    const get = (id: string, actor: Record<string, string> = headers) => f.app.handle(new Request(`${base}/blobs/${id}`, { headers: actor }));
    const del = (id: string, actor: Record<string, string> = headers) => f.app.handle(new Request(`${base}/blobs/${id}`, { method: "DELETE", headers: actor }));
    const audit = async () => { const page: AuditPage = await (await f.app.handle(new Request(`${base}/audit?limit=500`, { headers }))).json(); return page.events; };
    const json = (path: string, body: unknown, method: "POST" | "PUT" = "POST") => f.app.handle(new Request(`${base}${path}`, { method, headers: userHeaders, body: JSON.stringify(body) }));
    return { ...f, pool, store, disk, dataDir, base, key, runId, headers, userHeaders, put, get, del, audit, json,
      objects: async () => (await disk.scanPage(f.workspaceId)).map((ref) => `${ref.id}${ref.staging ? ".stage" : ""}`),
      deleteFault: (fault: "rollback" | "committed") => { deleteCommit = fault; },
      faults: (fault: string) => { failStage = fault === "stage"; failPromotion = fault === "promotion"; failRemove = fault === "remove"; uncertain = fault === "commit" || fault === "commit-unavailable"; unknownCommit = fault === "commit-unavailable"; },
      close: async () => {
        try {
          if (cleanupStorage) {
            failRemove = false; deleteCommit = ""; loseCommit = false;
            for (const row of await pool`SELECT id FROM control.blobs WHERE workspace_id=${f.workspaceId}`) expect((await del(row.id)).status).toBe(204);
            for (const id of staged) expect(await cleanupBlobs(pool, { ...f, runId }, disk, [id])).toBe(false);
          }
        } finally { await release(); } } };
  } catch (error) { await release().catch(() => {}); throw error; }
}
export async function uploaded(response: Response): Promise<Metadata> {
  expect(response.status).toBe(201); return await response.json();
}
