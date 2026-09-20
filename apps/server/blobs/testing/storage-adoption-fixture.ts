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
export const adoption = { mode: "adopt", checkpoint: "checkpoint-1", fenced: true, retain: false } satisfies AdoptionOptions;
export const initialization = { mode: "initialize", checkpoint: "", fenced: false, retain: false } satisfies AdoptionOptions;
export async function adoptionFixture() {
  const url = await migratedDatabase(), admin = createPool(adminUrl(url));
  const dataDir = await mkdtemp(join(tmpdir(), "bp-adoption-")), store = filesystemStore(dataDir);
  const cleanups: (() => Promise<void>)[] = [];
  const close = async () => {
    await Promise.all(cleanups.map(cleanup => cleanup()));
    await admin.close(); await rm(dataDir, { recursive: true, force: true });
  };
  try {
    const [schema] = await admin`SELECT to_regclass('control.blob_storage_retained') AS retained`;
    if (!schema.retained) {
      const path = Bun.env.BP_TEST_STORAGE_ADOPTION_SQL;
      if (!path) throw new Error("apply the adoption schema proposal or set BP_TEST_STORAGE_ADOPTION_SQL to its exact SQL");
      await admin.unsafe(await Bun.file(path).text());
    }
    const legacy = async () => {
      const runtime = createPool(url);
      try {
        const f = await principalFixture(runtime, { blobStore: store }, cleanup => cleanups.push(cleanup));
        const key = await issueKey(f.app, f.cookie, f.workspaceId, f.principalId), runId = await createRun(f.app, key, f.workspaceId);
        const response = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${f.workspaceId}/blobs?key=proof`, {
          method: "POST", body: "proof bytes", headers: { authorization: `Bearer ${key}`, "x-backplane-run": runId, "content-type": "application/octet-stream" },
        }));
        expect(response.status).toBe(201);
        const blob = await response.json() as { id: string };
        return { workspaceId: f.workspaceId, principalId: f.principalId, runId, id: blob.id };
      } finally { await runtime.close(); }
    };
    const verify = async (selected = store) => {
      const runtime = createPool(url);
      try { const release = await verifyStorageBinding(runtime, selected); await release(); }
      finally { await runtime.close(); }
    };
    return { url, admin, dataDir, store, legacy, verify, close, operate: (options: AdoptionOptions) => adoptStorage(admin, store, options) };
  } catch (error) { await close(); throw error; }
}
