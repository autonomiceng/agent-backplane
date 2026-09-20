import { expect, test } from "bun:test";
import { cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPool } from "../platform/pool.ts";
import { adoptStorage } from "./storage-adoption.ts";
import { filesystemStore } from "./filesystem-store.ts";
import { s3Store } from "./s3-store.ts";
import { cleanupBlobs } from "./sweep-blobs.ts";
import { storeMarker } from "./storage-binding.ts";
import { adoptionFixture, adoption, initialization } from "./testing/storage-adoption-fixture.ts";

test("normal initialization is durable and repeated initialization/startup does not change identity or bytes", async () => {
  const f = await adoptionFixture();
  try {
    expect((await f.operate(initialization)).status).toBe("ready");
    const before = await f.admin`SELECT * FROM control.blob_storage_binding`, marker = await f.store.readMarker();
    const drafts = await readdir(join(f.dataDir, ".blob-binding-intents"));
    expect((await f.operate(initialization)).status).toBe("already_bound");
    await f.verify();
    expect(await f.admin`SELECT * FROM control.blob_storage_binding`).toEqual(before);
    expect(await f.store.readMarker()).toEqual(marker);
    expect(await readdir(join(f.dataDir, ".blob-binding-intents"))).toEqual(drafts);
    const restore = join(f.dataDir, "restore");
    await cp(join(f.dataDir, "blobs"), join(restore, "blobs"), { recursive: true });
    await f.verify(filesystemStore(restore));
    await expect(adoptStorage(f.admin, s3Store({ endpoint: "http://127.0.0.1:1", bucket: "foreign", accessKeyId: "unused", secretAccessKey: "unused" }), initialization)).rejects.toThrow("blob_binding_intent_mismatch");
  } finally { await f.close(); }
});

test("legacy adoption preserves attribution and refuses missing/corrupt bytes before writing intent", async () => {
  const f = await adoptionFixture();
  try {
    const blob = await f.legacy(), before = await f.admin`SELECT * FROM control.blobs`;
    const path = join(f.dataDir, "blobs", blob.workspaceId, blob.id);
    await expect(f.operate(initialization)).rejects.toThrow("blob_binding_explicit_adoption_required");
    await expect(f.operate({ ...adoption, fenced: false })).rejects.toThrow("blob_binding_checkpoint_and_fence_required");
    await writeFile(path, "bad bytes");
    await expect(f.operate(adoption)).rejects.toThrow("blob_binding_content_mismatch");
    await rm(path);
    await expect(f.operate(adoption)).rejects.toThrow("blob_binding_inventory_mismatch");
    expect(await f.admin`SELECT * FROM control.blob_storage_binding`).toHaveLength(0);
    expect(await f.store.markerOrAbsent()).toBe(null);
    await writeFile(path, "proof bytes", { mode: 0o600 });
    expect((await f.operate(adoption)).status).toBe("ready");
    await f.verify();
    expect(await f.admin`SELECT * FROM control.blobs`).toEqual(before);
    await expect(f.operate({ ...adoption, checkpoint: "different" })).rejects.toThrow("blob_binding_intent_mismatch");
  } finally { await f.close(); }
});

test("publication failures retry only their exact durable intent and inventory", async () => {
  for (const published of [false, true]) {
    const f = await adoptionFixture();
    try {
      const blob = await f.legacy(), path = join(f.dataDir, "blobs", blob.workspaceId, blob.id);
      await expect(adoptStorage(f.admin, { ...f.store, publishMarker: async bytes => {
        if (published) await f.store.publishMarker(bytes);
        throw new Error("injected_publication_disconnect");
      } }, adoption)).rejects.toThrow("injected_publication_disconnect");
      const [intent] = await f.admin`SELECT * FROM control.blob_storage_binding`;
      expect(intent.phase).toBe("verifying");
      expect(await f.operate({ ...adoption, mode: "inspect", checkpoint: "" })).toMatchObject({
        binding: { databaseId: intent.database_id, storeId: intent.store_id, generation: intent.generation, backend: "filesystem", phase: "verifying" },
        intent: { phase: "verifying", operation: "adopt", checkpoint: adoption.checkpoint, retainUnreferenced: false },
      });
      expect(Boolean(await f.store.markerOrAbsent())).toBe(published);
      await expect(f.verify()).rejects.toThrow("blob_binding_not_ready");
      await expect(f.operate({ ...adoption, checkpoint: "changed" })).rejects.toThrow("blob_binding_intent_mismatch");
      await writeFile(path, "bad bytes");
      await expect(f.operate(adoption)).rejects.toThrow("blob_binding_content_mismatch");
      await writeFile(path, "proof bytes");
      expect((await f.operate(adoption)).status).toBe("ready");
      expect((await f.admin`SELECT generation FROM control.blob_storage_binding`)[0].generation).toBe(intent.generation);
      await f.verify();
    } finally { await f.close(); }
  }
});

test("explicit retention preserves staged and unreferenced bytes through cleanup and reconciliation", async () => {
  const f = await adoptionFixture();
  try {
    const blob = await f.legacy(), extra = crypto.randomUUID(), bytes = Buffer.from("leftover");
    await f.store.stage(blob.workspaceId, blob.id, bytes);
    await f.store.stage(blob.workspaceId, extra, bytes); await f.store.promote(blob.workspaceId, extra, bytes);
    const inspection = await f.operate({ ...adoption, mode: "inspect" });
    expect("binding" in inspection && inspection.binding).toBeNull();
    expect("objects" in inspection && inspection.objects.filter(ref => ref.classification === "unreferenced")).toHaveLength(2);
    await expect(f.operate(adoption)).rejects.toThrow("blob_binding_unreferenced_requires_retention");
    expect((await f.operate({ ...adoption, retain: true })).status).toBe("ready");
    await f.verify();
    const runtime = createPool(f.url);
    try { expect(await cleanupBlobs(runtime, blob, f.store, [blob.id, extra])).toBe(false); }
    finally { await runtime.close(); }
    expect(await f.store.readStored(blob.workspaceId, { id: blob.id, staging: true })).toEqual(bytes);
    expect(await f.store.open(blob.workspaceId, extra)).toEqual(bytes);
    const later = crypto.randomUUID(); await f.store.stage(blob.workspaceId, later, bytes);
    await expect(f.verify()).rejects.toThrow("blob_binding_inventory_mismatch");
    expect((await f.operate({ ...adoption, mode: "reconcile", checkpoint: "checkpoint-2", retain: true })).status).toBe("ready");
    await f.verify();
    expect(await f.admin`SELECT * FROM control.blob_storage_retained`).toHaveLength(3);
    expect(await f.store.readStored(blob.workspaceId, { id: later, staging: true })).toEqual(bytes);
  } finally { await f.close(); }
});

test("competing databases cannot claim one store and a foreign marker is never replaced", async () => {
  const a = await adoptionFixture(), b = await adoptionFixture();
  try {
    const results = await Promise.allSettled([adoptStorage(a.admin, a.store, initialization), adoptStorage(b.admin, a.store, initialization)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const marker = await readFile(join(a.dataDir, "blobs", storeMarker));
    const loser = results[0]?.status === "rejected" ? a : b;
    await expect(adoptStorage(loser.admin, a.store, initialization)).rejects.toThrow();
    expect(await readFile(join(a.dataDir, "blobs", storeMarker))).toEqual(marker);
  } finally { await a.close(); await b.close(); }
});


test("operator initialization refuses live runtime sessions before writing intent or storage", async () => {
  const f = await adoptionFixture(), runtime = createPool(f.url);
  try {
    await runtime`SELECT 1`;
    await expect(f.operate(initialization)).rejects.toThrow("blob_binding_stop_all_servers");
    expect(await f.admin`SELECT * FROM control.blob_storage_binding`).toHaveLength(0);
    expect(await readdir(f.dataDir)).toEqual([]);
  } finally { await runtime.close(); await f.close(); }
});
