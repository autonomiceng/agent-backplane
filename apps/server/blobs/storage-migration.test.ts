import { describe, expect, test } from "bun:test";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { migrationFixture } from "./testing/storage-migration-fixture.ts";
import { migrationBinding, migrateStorage } from "./storage-migration.ts";
import { bindingBytes, verifyStorageBinding } from "./storage-binding.ts";
import { checkpointProof } from "./storage-migration-checkpoint.ts";
import { adoptStorage } from "./storage-adoption.ts";
import { adoption, initialization } from "./testing/storage-adoption-fixture.ts";

describe.skipIf(!Bun.env.BP_MIGRATION_TEST_ENDPOINT)("owned RustFS migration", () => {
test("migration preserves two Principals' Files, metadata, audit, SQL and physical retained staging", async () => {
  const f = await migrationFixture();
  try {
    const blobs = await f.admin`SELECT * FROM control.blobs ORDER BY id`, heads = await f.admin`SELECT * FROM audit.cursor`;
    const marker = await f.store.readMarker(), audit = await f.admin`SELECT * FROM audit.events ORDER BY workspace_id,position`;
    await f.operate("prepare"); await f.operate("copy");
    const after = await f.capture(true); await f.operate("complete", f.targetStore, after.proof);
    const release = await verifyStorageBinding(f.admin, f.targetStore); await release();
    expect(await f.admin`SELECT * FROM control.blobs ORDER BY id`).toEqual(blobs);
    expect(await f.admin`SELECT * FROM audit.cursor`).toEqual(heads);
    expect(await f.admin`SELECT * FROM audit.events ORDER BY workspace_id,position`).toEqual(audit);
    expect(await f.store.readMarker()).toEqual(marker);
    expect(await f.targetStore.readStored(f.workspace, { id: f.retained, staging: true })).toEqual(Buffer.from("retained staging"));
    for (const actor of f.actors) expect(await f.store.open(f.workspace, actor.id)).toEqual(Buffer.from(actor.principalId));
    expect((await f.intent()).phase).toBe("complete");
    await f.serve();
  } finally { await f.close(); }
}, 60000);

test("intent, partial copy, published marker and lost precommit connection resume the same immutable intent", async () => {
  const f = await migrationFixture();
  try {
    await f.operate("prepare"); const original = await f.intent(), marker = await f.store.readMarker();
    expect(await adoptStorage(f.admin, f.store, { ...adoption, mode: "inspect" })).toMatchObject({ migration: { id: f.id, phase: "copying" } });
    await expect(adoptStorage(f.admin, f.store, { ...adoption, mode: "reconcile" })).rejects.toThrow("blob_binding_migration_pending");
    await expect(f.verify()).rejects.toThrow("blob_binding_migration_pending");
    await expect(f.operate("copy", { ...f.targetStore, async createStored(workspace, ref, bytes) {
      await f.targetStore.createStored(workspace, ref, bytes); throw new Error("copy interrupted");
    } })).rejects.toThrow("copy interrupted");
    await expect(f.operate("copy", { ...f.targetStore, async publishMarker(bytes) {
      await f.targetStore.publishMarker(bytes); throw new Error("marker interrupted");
    } })).rejects.toThrow("marker interrupted");
    expect(await f.targetStore.readMarker()).toEqual(bindingBytes(migrationBinding(original, true)));
    await expect(f.operate("copy", { ...f.targetStore, async publishMarker(bytes) {
      await f.targetStore.publishMarker(bytes);
      await f.admin`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=112933 AND objid=32 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;
    } })).rejects.toThrow();
    expect(await f.intent()).toEqual(original);
    await f.operate("copy");
    expect(await f.intent()).toEqual({ ...original, phase: "committed_pending_checkpoint" });
    expect(await f.store.readMarker()).toEqual(marker);
  } finally { await f.close(); }
}, 60000);

test("pending cutover repairs only absent bytes under the same binding before verified S3 custody releases startup", async () => {
  const f = await migrationFixture();
  try {
    await f.operate("prepare"); await f.operate("copy");
    expect(await adoptStorage(f.admin, f.targetStore, { ...adoption, mode: "inspect" })).toMatchObject({ migration: { id: f.id, phase: "committed_pending_checkpoint" } });
    await expect(verifyStorageBinding(f.admin, f.targetStore)).rejects.toThrow("blob_binding_migration_pending");
    await expect(f.operate("complete")).rejects.toThrow("blob_binding_migration_mismatch");
    await expect(f.operate("abort")).rejects.toThrow("blob_binding_migration_mismatch");
    await expect(f.operate("copy")).rejects.toThrow("blob_binding_migration_mismatch");
    await expect(f.operate("prepare")).rejects.toThrow();
    for (const options of [initialization, adoption, { ...adoption, mode: "reconcile" as const }]) {
      await expect(adoptStorage(f.admin, f.targetStore, options)).rejects.toThrow("blob_binding_migration_pending");
    }
    await expect(f.admin.begin(async tx => {
      await tx`SET LOCAL ROLE bp_server`;
      await tx`UPDATE control.blob_storage_migration SET phase='complete'`;
    })).rejects.toThrow();
    await expect(f.admin.begin(async tx => {
      await tx`SET LOCAL ROLE bp_executor`;
      await tx`DELETE FROM control.blob_storage_migration`;
    })).rejects.toThrow();
    await expect(Promise.resolve(f.admin`UPDATE control.blob_storage_migration SET target_store_id=${crypto.randomUUID()}`)).rejects.toThrow();
    const binding = await f.admin`SELECT * FROM control.blob_storage_binding`, intent = await f.intent();
    const slowTarget = { ...f.targetStore, async open(workspace: string, id: string) {
      await Bun.sleep(600); return f.targetStore.open(workspace, id);
    } };
    const sourceRoot = join(f.dataDir, "blobs"), unavailable = join(f.dataDir, "blobs-unavailable");
    await rename(sourceRoot, unavailable);
    try {
      await expect(f.operate("repair", slowTarget, f.before.proof, 1000)).resolves.toEqual({ phase: "committed_pending_checkpoint", id: f.id });
      expect(await f.admin`SELECT * FROM control.blob_storage_binding`).toEqual(binding);
      expect(await f.intent()).toEqual(intent);
    } finally { await rename(unavailable, sourceRoot); }
    const missing = f.actors[0]!, divergent = f.actors[1]!;
    await f.targetStore.remove(f.workspace, { id: missing.id, staging: false }); await f.eraseTargetMarker();
    const sourcePath = join(f.dataDir, "blobs", f.workspace, missing.id);
    await writeFile(sourcePath, "source changed");
    await expect(f.operate("repair")).rejects.toThrow("blob_binding_content_mismatch");
    await writeFile(sourcePath, missing.principalId);
    await expect(f.operate("repair", f.targetStore, { ...f.before.proof, doc: { ...f.before.proof.doc,
      after: { ...f.before.proof.doc.after, timeline: f.before.proof.doc.after.timeline + 1 } } })).rejects.toThrow("blob_binding_migration_mismatch");
    await f.targetStore.remove(f.workspace, { id: divergent.id, staging: false });
    await f.targetStore.createStored(f.workspace, { id: divergent.id, staging: false }, Buffer.from("divergent"));
    await expect(f.operate("repair")).rejects.toThrow("blob_binding_migration_mismatch");
    await expect(f.targetStore.open(f.workspace, missing.id)).rejects.toThrow();
    expect(await f.targetStore.markerOrAbsent()).toBeNull();
    expect(await f.targetStore.open(f.workspace, divergent.id)).toEqual(Buffer.from("divergent"));
    await f.targetStore.remove(f.workspace, { id: divergent.id, staging: false });
    await f.targetStore.createStored(f.workspace, { id: divergent.id, staging: false }, Buffer.from(divergent.principalId));
    await f.operate("repair", slowTarget, f.before.proof, 1000); await f.operate("repair");
    expect(await f.targetStore.open(f.workspace, missing.id)).toEqual(Buffer.from(missing.principalId));
    expect(await f.targetStore.readMarker()).toEqual(bindingBytes(migrationBinding(intent, true)));
    expect(await f.admin`SELECT * FROM control.blob_storage_binding`).toEqual(binding);
    expect(await f.intent()).toEqual(intent);
    await expect(verifyStorageBinding(f.admin, f.targetStore)).rejects.toThrow("blob_binding_migration_pending");
    const after = await f.capture(true);
    await writeFile(after.pin, JSON.stringify({ manifestSha256: "0".repeat(64) }), { mode: 0o600 });
    await expect(checkpointProof(after.directory, after.digest, after.pin)).rejects.toThrow("blob_binding_checkpoint_pin");
    expect((await f.intent()).phase).toBe("committed_pending_checkpoint");
    await writeFile(after.pin, JSON.stringify({ manifestSha256: after.digest }), { mode: 0o600 });
    await f.operate("complete", f.targetStore, await checkpointProof(after.directory, after.digest, after.pin));
    expect(await f.admin`SELECT * FROM control.blob_storage_migration_completion`).toHaveLength(1);
    await f.targetStore.remove(f.workspace, { id: missing.id, staging: false });
    await expect(f.operate("repair")).rejects.toThrow("blob_binding_migration_mismatch");
    await expect(f.targetStore.open(f.workspace, missing.id)).rejects.toThrow();
  } finally { await f.close(); }
}, 60000);

test("checkpoint, target and startup-budget qualification refuse unsafe binding cutover", async () => {
  const f = await migrationFixture();
  try {
    await expect(checkpointProof(f.before.directory, "0".repeat(64), f.before.pin)).rejects.toThrow("blob_binding_checkpoint_hash");
    const path = join(f.before.directory, "server-data.tar"), bytes = await readFile(path); await writeFile(path, "changed");
    await expect(checkpointProof(f.before.directory, f.before.digest, f.before.pin)).rejects.toThrow("blob_binding_checkpoint_artifacts");
    await writeFile(path, bytes);
    await expect(f.operate("prepare", f.targetStore, { ...f.before.proof, doc: { ...f.before.proof.doc,
      storage: { ...f.before.proof.doc.storage, inventorySha256: "0".repeat(64) } } })).rejects.toThrow();
    expect(await f.admin`SELECT * FROM control.blob_storage_migration`).toHaveLength(0);
    await f.operate("prepare"); const intent = await f.intent();
    const binding = await f.admin`SELECT * FROM control.blob_storage_binding`, marker = await f.store.readMarker();
    await expect(f.operate("copy", { ...f.targetStore, async open(workspace, id) {
      await Bun.sleep(600); return f.targetStore.open(workspace, id);
    } }, f.before.proof, 1000)).rejects.toThrow("blob_binding_migration_startup_budget");
    expect(await f.intent()).toEqual(intent);
    expect(await f.admin`SELECT * FROM control.blob_storage_binding`).toEqual(binding);
    expect(await f.store.readMarker()).toEqual(marker);
    expect(await f.targetStore.markerOrAbsent()).toBeNull();
    const extra = crypto.randomUUID(); await f.targetStore.createStored(f.workspace, { id: extra, staging: false }, Buffer.from("foreign"));
    await expect(f.operate("copy")).rejects.toThrow("blob_binding_migration_mismatch");
    await expect(migrateStorage(f.admin, f.store, f.targetStore, { action: "copy", id: f.id, target: { ...f.target, credentialsSha256: "b".repeat(64) },
      proof: f.before.proof, timeoutMs: 30000, startupTimeoutMs: 120000, attestTarget: async () => {} })).rejects.toThrow("blob_binding_migration_mismatch");
    const versioning = await f.bucketRequest("PUT", "?versioning=", '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>');
    await versioning.body?.cancel(); expect(versioning.ok).toBe(true);
    await expect(f.operate("copy")).rejects.toThrow("blob_binding_migration_target_proof");
    expect(await f.targetStore.open(f.workspace, extra)).toEqual(Buffer.from("foreign"));
    expect(await f.targetStore.markerOrAbsent()).toBeNull(); expect(await f.intent()).toEqual(intent);
  } finally { await f.close(); }
}, 60000);

test("abort preserves history and partial target while a fresh explicit migration can complete", async () => {
  const f = await migrationFixture();
  try {
    await f.operate("prepare");
    await expect(f.operate("copy", { ...f.targetStore, async createStored(workspace, ref, bytes) {
      await f.targetStore.createStored(workspace, ref, bytes); throw new Error("copy interrupted");
    } })).rejects.toThrow();
    const partial = []; for await (const ref of f.targetStore.inventory()) partial.push(ref);
    expect(partial).toHaveLength(1);
    const actor = f.actors[0]!, path = join(f.dataDir, "blobs", f.workspace, actor.id);
    await writeFile(path, "changed"); await expect(f.operate("abort")).rejects.toThrow();
    expect((await f.intent()).phase).toBe("copying"); await writeFile(path, actor.principalId);
    await f.operate("abort"); await f.verify();
    const remaining = []; for await (const ref of f.targetStore.inventory()) remaining.push(ref);
    expect(remaining).toEqual(partial); expect((await f.intent()).phase).toBe("aborted");
    await expect(f.operate("copy")).rejects.toThrow();
    const aborted = await f.intent(), oldMarker = await f.targetStore.markerOrAbsent();
    const partialBytes = await Promise.all(partial.map(ref => f.targetStore.readStored(ref.workspace, { id: ref.id, staging: Boolean(ref.staging) })));
    await f.serve(f.store); await f.verify();
    const checkpoint = await f.capture(), next = await f.freshTarget(), id = crypto.randomUUID();
    expect(checkpoint.digest).not.toBe(f.before.digest);
    const options = { id, target: next.target, proof: checkpoint.proof, attestTarget: next.attestTarget, timeoutMs: 30000, startupTimeoutMs: 120000 };
    await expect(migrateStorage(f.admin, f.store, f.targetStore, { ...options, target: f.target, action: "prepare" })).rejects.toThrow();
    await migrateStorage(f.admin, f.store, next.store, { ...options, action: "prepare" });
    expect((await f.intent(id)).phase).toBe("copying");
    await expect(migrateStorage(f.admin, f.store, next.store, { ...options, id: crypto.randomUUID(), action: "prepare" })).rejects.toThrow();
    await f.operate("abort");
    await expect(f.verify()).rejects.toThrow("blob_binding_migration_pending");
    await expect(f.operate("copy")).rejects.toThrow();
    await migrateStorage(f.admin, f.store, next.store, { ...options, action: "copy", emptyTarget: true });
    const after = await f.capture(true, id, next.store);
    await expect(f.operate("complete", next.store, after.proof)).rejects.toThrow();
    await migrateStorage(f.admin, f.store, next.store, { ...options, action: "complete", proof: after.proof });
    const release = await verifyStorageBinding(f.admin, next.store); await release();
    expect((await f.intent(id)).phase).toBe("complete");
    expect(await f.intent()).toEqual(aborted);
    expect(await f.admin`SELECT id FROM control.blob_storage_migration ORDER BY id`).toHaveLength(2);
    expect(await f.admin<{ migration_id: string }[]>`SELECT migration_id FROM control.blob_storage_migration_completion`).toEqual([{ migration_id: id }]);
    expect(await Array.fromAsync(f.targetStore.inventory())).toEqual(partial);
    expect(await Promise.all(partial.map(ref => f.targetStore.readStored(ref.workspace, { id: ref.id, staging: Boolean(ref.staging) })))).toEqual(partialBytes);
    expect(await f.targetStore.markerOrAbsent()).toEqual(oldMarker);
    await f.serve(next.store);
  } finally { await f.close(); }
}, 60000);

});
