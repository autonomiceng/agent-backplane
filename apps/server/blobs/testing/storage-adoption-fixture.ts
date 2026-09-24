// Real PostgreSQL and authenticated blob creation; admin writes stay in private control state.
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool } from "../../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../../testing/postgres.ts";
import { principalFixture, issueKey, createRun } from "../../testing/session.ts";
import { filesystemStore } from "../filesystem-store.ts";
import { adoptStorage, type AdoptionOptions } from "../storage-adoption.ts";
import { verifyStorageBinding } from "../storage-binding.ts";
export const reconciliation = { mode: "reconcile", checkpoint: "checkpoint-1", fenced: true, retain: false } satisfies AdoptionOptions;
export const initialization = { mode: "initialize", checkpoint: "", fenced: false, retain: false } satisfies AdoptionOptions;
export async function adoptionFixture() {
  const url = await migratedDatabase(), admin = createPool(adminUrl(url));
  const dataDir = await mkdtemp(join(tmpdir(), "bp-adoption-")), store = filesystemStore(dataDir);
  const cleanups: (() => Promise<void>)[] = [];
  const close = async () => {
    const results = await Promise.allSettled(cleanups.map(cleanup => cleanup()));
    results.push(...await Promise.allSettled([admin.close(), rm(dataDir, { recursive: true, force: true })]));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  try {
    const [schema] = await admin`SELECT to_regclass('control.blob_storage_retained') AS retained`;
    if (!schema.retained) throw new Error("migration 000032 not applied");
    const waitForStoppedRuntime = async () => {
      // Client close can resolve before PostgreSQL removes its backend record.
      const deadline = performance.now() + 5000;
      while (true) {
        const [active] = await admin`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename='bp_server'`;
        if (!active.count) return;
        if (performance.now() >= deadline) throw new Error("fixture runtime did not stop");
        await Bun.sleep(10);
      }
    };
    const writeBlob = async () => {
      const runtime = createPool(url, 1);
      try {
        const f = await principalFixture(runtime, { blobStore: store }, cleanup => cleanups.push(cleanup));
        const key = await issueKey(f.app, f.cookie, f.workspaceId, f.principalId), runId = await createRun(f.app, key, f.workspaceId);
        const response = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${f.workspaceId}/blobs?key=proof`, {
          method: "POST", body: "proof bytes", headers: { authorization: `Bearer ${key}`, "x-backplane-run": runId, "content-type": "application/octet-stream" },
        }));
        expect(response.status).toBe(201);
        const blob = await response.json() as { id: string };
        return { workspaceId: f.workspaceId, principalId: f.principalId, runId, id: blob.id };
      } finally {
        await runtime.close();
        await waitForStoppedRuntime();
      }
    };
    const verify = async (selected = store) => {
      // This fixture borrows one lease; avoid unrelated pool connection handshakes at its fence.
      const runtime = createPool(url, 1);
      try { const release = await verifyStorageBinding(runtime, selected); await release(); }
      finally { await runtime.close(); await waitForStoppedRuntime(); }
    };
    return { url, admin, dataDir, store, writeBlob, verify, close, operate: (options: AdoptionOptions) => adoptStorage(admin, store, options) };
  } catch (error) {
    try { await close(); } catch { /* Preserve the setup failure after attempting every cleanup. */ }
    throw error;
  }
}
