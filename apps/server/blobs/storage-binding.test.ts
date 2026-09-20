import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { createRun, issueKey, principalFixture } from "../testing/session.ts";
import { cleanupBlobs } from "./sweep-blobs.ts";
import { filesystemStore } from "./filesystem-store.ts";
import { s3Store } from "./s3-store.ts";
import { storeMarker, verifyStorageBinding } from "./storage-binding.ts";

async function fixture() {
  const url = await migratedDatabase(), pool = createPool(url), admin = createPool(adminUrl(url));
  const dataDir = await mkdtemp(join(tmpdir(), "bp-binding-")), store = filesystemStore(dataDir);
  const cleanups: (() => Promise<void>)[] = [];
  const close = async () => {
    await Promise.all(cleanups.map(cleanup => cleanup()));
    await pool.close(); await admin.close(); await rm(dataDir, { recursive: true, force: true });
  };
  try {
    const [schema] = await admin`SELECT to_regclass('control.blob_storage_binding') AS binding`;
    if (!schema.binding) throw new Error("migration 000032 not applied");
    const [retention] = await admin`SELECT to_regclass('control.blob_storage_retained') AS retained`;
    if (!retention.retained) throw new Error("migration 000032 not applied");
    const f = await principalFixture(pool, { blobStore: store }, cleanup => cleanups.push(cleanup));
    const key = await issueKey(f.app, f.cookie, f.workspaceId, f.principalId), runId = await createRun(f.app, key, f.workspaceId);
    const identity = { database: crypto.randomUUID(), store: crypto.randomUUID(), generation: crypto.randomUUID() };
    const marker = `backplane-blob-store-v1\n${identity.database}\n${identity.store}\n${identity.generation}\nfilesystem\n`;
    const markerPath = join(dataDir, "blobs", storeMarker);
    const bind = async () => {
      // Test-only control-plane setup, never Workspace or queue writes.
      await admin`INSERT INTO control.blob_storage_binding(database_id,store_id,generation,backend,phase)
        VALUES(${identity.database},${identity.store},${identity.generation},'filesystem','ready')`;
      await mkdir(join(dataDir, "blobs"), { mode: 0o700, recursive: true });
      await writeFile(markerPath, marker, { mode: 0o600 });
    };
    const put = async () => {
      const response = await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${f.workspaceId}/blobs?key=proof`, {
        method: "POST", body: "proof bytes", headers: { authorization: `Bearer ${key}`, "x-backplane-run": runId, "content-type": "application/octet-stream" },
      }));
      expect(response.status).toBe(201);
      return await response.json() as { id: string };
    };
    return { ...f, pool, admin, dataDir, store, marker, markerPath, bind, put, runId, close };
  } catch (error) { await close(); throw error; }
}

test("fresh and legacy stores never initialize implicitly, including missing or corrupt legacy bytes", async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled([verifyStorageBinding(f.pool, f.store), verifyStorageBinding(f.pool, f.store)]);
    expect(results.every(result => result.status === "rejected")).toBe(true);
    expect(await readdir(f.dataDir)).toEqual([]);
    await mkdir(join(f.dataDir, "blobs"), { mode: 0o700 });
    await writeFile(f.markerPath, f.marker, { mode: 0o600 });
    await expect(verifyStorageBinding(f.pool, f.store)).rejects.toThrow("blob_binding_required");
    expect(await readFile(f.markerPath, "utf8")).toBe(f.marker);
    await rm(f.markerPath);
    const blob = await f.put(), path = join(f.dataDir, "blobs", f.workspaceId, blob.id);
    for (const state of ["correct", "corrupt", "missing"]) {
      if (state === "corrupt") await writeFile(path, "wrong bytes");
      if (state === "missing") await rm(path);
      await expect(verifyStorageBinding(f.pool, f.store)).rejects.toThrow("blob_binding_required");
      expect(await Bun.file(f.markerPath).exists()).toBe(false);
    }
    expect(await f.pool`SELECT id FROM control.blobs`).toHaveLength(1);
  } finally { await f.close(); }
});

test("verified store holds the single-server lease and keeps its marker out of orphan cleanup", async () => {
  const f = await fixture();
  let stop: (() => Promise<void>) | undefined;
  try {
    await f.put(); await f.bind();
    const before = await f.pool`SELECT * FROM control.blobs`;
    stop = await verifyStorageBinding(f.pool, f.store);
    await expect(verifyStorageBinding(f.pool, f.store)).rejects.toThrow("blob_binding_busy");
    const orphan = crypto.randomUUID();
    await f.store.stage(f.workspaceId, orphan, Buffer.from("orphan"));
    expect(await cleanupBlobs(f.pool, { ...f, runId: f.runId }, f.store, [orphan])).toBe(false);
    expect(await readFile(f.markerPath, "utf8")).toBe(f.marker);
    expect(await f.pool`SELECT * FROM control.blobs`).toEqual(before);
    await stop(); stop = await verifyStorageBinding(f.pool, filesystemStore(f.dataDir));
    await expect(f.pool`DELETE FROM control.blob_storage_binding`.then()).rejects.toThrow();
  } finally { await stop?.(); await f.close(); }
});

test("wrong backend, wrong marker, partial binding, and ambiguous records fail closed", async () => {
  const f = await fixture();
  try {
    await f.bind();
    const s3 = s3Store({ endpoint: "http://127.0.0.1:1", bucket: "other", accessKeyId: "unused", secretAccessKey: "unused" });
    await expect(verifyStorageBinding(f.pool, s3)).rejects.toThrow("blob_binding_backend_mismatch");
    for (const marker of ["corrupt", f.marker.replace("filesystem", "s3"), f.marker.replace(/backplane/, "foreign"), f.marker.replace(/\n[0-9a-f-]+\n/, `\n${crypto.randomUUID()}\n`)]) {
      await writeFile(f.markerPath, marker);
      await expect(verifyStorageBinding(f.pool, f.store)).rejects.toThrow("blob_binding_marker_mismatch");
      expect(await readFile(f.markerPath, "utf8")).toBe(marker);
    }
    await writeFile(f.markerPath, f.marker);
    await f.admin`UPDATE control.blob_storage_binding SET phase='verifying'`;
    await expect(verifyStorageBinding(f.pool, f.store)).rejects.toThrow("blob_binding_not_ready");
    // Deliberately damage the protected schema to exercise ambiguous-record refusal.
    await f.admin`ALTER TABLE control.blob_storage_binding DROP CONSTRAINT blob_storage_binding_singleton_check`;
    await f.admin`INSERT INTO control.blob_storage_binding(singleton,database_id,store_id,generation,backend,phase) SELECT false,database_id,store_id,generation,backend,'ready' FROM control.blob_storage_binding`;
    await expect(verifyStorageBinding(f.pool, f.store)).rejects.toThrow("blob_binding_ambiguous");
  } finally { await f.close(); }
});

test("copied markers cannot authorize missing, corrupt, or extra bytes and no cleanup starts on refusal", async () => {
  const f = await fixture();
  try {
    const blob = await f.put(); await f.bind();
    const target = join(f.dataDir, "copy");
    await mkdir(join(target, "blobs"), { recursive: true, mode: 0o700 });
    await cp(f.markerPath, join(target, "blobs", storeMarker));
    const copy = filesystemStore(target);
    let cleanupStarted = false;
    const start = async () => {
      const stop = await verifyStorageBinding(f.pool, copy);
      cleanupStarted = true;
      try { await cleanupBlobs(f.pool, { ...f, runId: f.runId }, copy); } finally { await stop(); }
    };
    await expect(start()).rejects.toThrow("blob_binding_inventory_mismatch");
    expect(await readdir(join(target, "blobs"))).toEqual([storeMarker]);
    await copy.stage(f.workspaceId, blob.id, Buffer.from("wrong bytes"));
    await copy.promote(f.workspaceId, blob.id, Buffer.from("wrong bytes"));
    await expect(start()).rejects.toThrow("blob_binding_content_mismatch");
    const copyPath = join(target, "blobs", f.workspaceId, blob.id);
    await writeFile(copyPath, "proof bytes");
    const extra = crypto.randomUUID();
    await copy.stage(f.workspaceId, extra, Buffer.from("foreign bytes"));
    await copy.promote(f.workspaceId, extra, Buffer.from("foreign bytes"));
    await expect(start()).rejects.toThrow("blob_binding_inventory_mismatch");
    expect(cleanupStarted).toBe(false);
    expect(await copy.open(f.workspaceId, extra)).toEqual(Buffer.from("foreign bytes"));
    expect(await f.store.open(f.workspaceId, blob.id)).toEqual(Buffer.from("proof bytes"));
  } finally { await f.close(); }
});

test("missing markers, unsafe files, staging leftovers and failed reads preserve bytes", async () => {
  const f = await fixture();
  try {
    const blob = await f.put(); await f.bind();
    await rm(f.markerPath);
    await expect(verifyStorageBinding(f.pool, f.store)).rejects.toThrow("blob_binding_marker_missing");
    const path = join(f.dataDir, "blobs", f.workspaceId, blob.id);
    await symlink(path, f.markerPath);
    await expect(verifyStorageBinding(f.pool, f.store)).rejects.toThrow("blob_binding_unavailable");
    await rm(f.markerPath); await writeFile(f.markerPath, f.marker, { mode: 0o600 });
    const stage = crypto.randomUUID();
    await f.store.stage(f.workspaceId, stage, Buffer.from("pending"));
    await expect(verifyStorageBinding(f.pool, f.store)).rejects.toThrow("blob_binding_inventory_mismatch");
    expect(await readFile(join(f.dataDir, "blobs", f.workspaceId, `${stage}.stage`), "utf8")).toBe("pending");
    await rm(join(f.dataDir, "blobs", f.workspaceId, `${stage}.stage`));
    // Deterministic mid-read outage, which a local filesystem cannot reliably induce.
    await expect(verifyStorageBinding(f.pool, { ...f.store, open: async () => { throw new Error("credential-secret"); } })).rejects.toThrow(/^blob_binding_unavailable$/);
    expect(await readFile(path, "utf8")).toBe("proof bytes");
    const stray = join(f.dataDir, "blobs", "stray"); await writeFile(stray, "preserve");
    await expect(verifyStorageBinding(f.pool, f.store)).rejects.toThrow("blob_binding_store_invalid");
    expect(await readFile(stray, "utf8")).toBe("preserve"); await rm(stray);
    const stop = await verifyStorageBinding(f.pool, f.store); await stop();
  } finally { await f.close(); }
});
