// Real PostgreSQL and a root-owned disposable RustFS. Recovery archives belong to the separate drill.
import { expect } from "bun:test";
import { S3Client } from "bun";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { s3AdminRequest } from "../s3-admin-request.ts";
import { createPool } from "../../platform/pool.ts";
import { applyMigration, createRun, issueKey, principalFixture, testApp } from "../../testing/session.ts";
import { adoptionFixture, adoption } from "./storage-adoption-fixture.ts";
import { blobHash } from "../blob-store.ts";
import { s3Store } from "../s3-store.ts";
import { checkpointProof } from "../storage-migration-checkpoint.ts";
import { migrateStorage, migrationSnapshot, type MigrationIntent } from "../storage-migration.ts";
import type { BindingStore } from "../storage-binding.ts";
import { storageInventory } from "../storage-inventory.ts";
export async function migrationFixture() {
  const f = await adoptionFixture();
  const cleanups: (() => Promise<void>)[] = [];
  try {
  const endpoint = Bun.env.BP_MIGRATION_TEST_ENDPOINT;
  if (!endpoint) throw new Error("use tests/acceptance/storage-migration.ts to own the RustFS fixture");
  const bucket = "migration-" + crypto.randomUUID();
  const options = { endpoint, bucket, region: "us-east-1", accessKeyId: Bun.env.BP_MIGRATION_TEST_ACCESS!, secretAccessKey: Bun.env.BP_MIGRATION_TEST_SECRET! };
  const bucketRequest = (method: "PUT" | "GET", query = "", body = "", selectedBucket = bucket) =>
    s3AdminRequest(endpoint, options.accessKeyId, options.secretAccessKey, `/${selectedBucket}${query}`, method, body);
  const response = await bucketRequest("PUT"); await response.body?.cancel();
  if (!response.ok) throw new Error("migration fixture bucket creation failed");
  const attestTarget = async (selectedBucket = bucket) => {
    const response = await bucketRequest("GET", "?versioning=", "", selectedBucket);
    const xml = (await response.text()).replace(/<\?xml.*?\?>/s, "").trim();
    if (!response.ok || !/^<VersioningConfiguration\b[^>]*(?:\/>|>\s*<\/VersioningConfiguration>)$/.test(xml)) throw new Error("blob_binding_migration_target_proof");
  };
  const targetStore = s3Store(options), runtime = createPool(f.url, 1);
  const actors: { key: string; runId: string; principalId: string; id: string }[] = [];
  let workspace = "";
  try {
    const user = await principalFixture(runtime, { blobStore: f.store }, cleanup => cleanups.push(cleanup));
    workspace = user.workspaceId;
    const second = await user.app.handle(new Request(`http://localhost/api/v1/workspaces/${workspace}/principals`, {
      method: "POST", headers: { cookie: user.cookie, origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ name: "Second" }),
    }));
    expect(second.status).toBe(201);
    const principal = await second.json() as { id: string };
    for (const principalId of [user.principalId, principal.id]) {
      const key = await issueKey(user.app, user.cookie, workspace, principalId), runId = await createRun(user.app, key, workspace);
      const response = await user.app.handle(new Request(`http://localhost/api/v1/workspaces/${workspace}/blobs?key=${principalId}`, {
        method: "POST", headers: { authorization: `Bearer ${key}`, "x-backplane-run": runId, "content-type": "application/octet-stream" }, body: principalId,
      }));
      expect(response.status).toBe(201);
      const { id } = await response.json() as { id: string };
      actors.push({ key, runId, principalId, id });
    }
    const first = actors[0]!;
    await applyMigration(user.app, first.key, first.runId, workspace, "CREATE TABLE migration_proof (id integer PRIMARY KEY, proof text NOT NULL)");
    const sql = await user.app.handle(new Request(`http://localhost/api/v1/workspaces/${workspace}/sql`, {
      method: "POST", headers: { authorization: `Bearer ${first.key}`, "x-backplane-run": first.runId, "content-type": "application/json" },
      body: JSON.stringify({ statement: "INSERT INTO migration_proof VALUES (1, 'preserved')", params: [] }),
    }));
    expect(sql.status).toBe(200);
  } finally { await runtime.close(); }
  const until = performance.now() + 5000;
  while ((await f.admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename='bp_server'`)[0].n) {
    if (performance.now() > until) throw new Error("migration fixture runtime did not stop");
    await Bun.sleep(10);
  }
  const retained = crypto.randomUUID();
  await f.store.stage(workspace, retained, Buffer.from("retained staging"));
  await f.operate({ ...adoption, retain: true });
  const id = crypto.randomUUID();
  const target = { project: "migration-test", volume: "migration-test-" + id, bucket, endpoint: "http://rustfs:9000",
    image: "sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff", credentialsSha256: "a".repeat(64) };
  const freshTarget = async () => {
    const bucket = "migration-" + crypto.randomUUID();
    const response = await bucketRequest("PUT", "", "", bucket); await response.body?.cancel();
    if (!response.ok) throw new Error("migration fixture bucket creation failed");
    return { store: s3Store({ ...options, bucket }), target: { ...target, bucket, volume: "migration-test-" + crypto.randomUUID() },
      attestTarget: () => attestTarget(bucket) };
  };
  const capture = async (s3 = false, migrationId = id, store = targetStore) => {
    const directory = join(f.dataDir, crypto.randomUUID()); await mkdir(join(directory, "postgres"), { recursive: true, mode: 0o700 });
    const artifacts: Record<string, { sha256: string; bytes: number }> = {};
    for (const name of ["postgres/base.tar", "postgres/pg_wal.tar", "postgres/backup_manifest", "server-data.tar", "server-image.tar", ...(s3 ? ["rustfs-data.tar"] : [])]) {
      const bytes = Buffer.from("engine custody fixture " + name); await writeFile(join(directory, name), bytes, { mode: 0o600 });
      artifacts[name] = { sha256: blobHash(bytes), bytes: bytes.length };
    }
    const doc = await f.admin.begin(async tx => {
      const snapshot = await migrationSnapshot(tx), [binding] = await tx`SELECT * FROM control.blob_storage_binding`;
      const inventory = await storageInventory(tx, s3 ? store : f.store);
      return { version: 1, captureMode: "offline", name: "20260920T000000000000Z", completedAt: new Date().toISOString(), before: snapshot, after: snapshot, artifacts,
        storage: { databaseId: binding.database_id, storeId: binding.store_id, generation: binding.generation, backend: binding.backend,
          phase: binding.phase, inventorySha256: inventory.digest, objectCount: inventory.objects.length },
        ...(s3 ? { rustfsExitCode: 0, migration: { id: migrationId, phase: "committed_pending_checkpoint" } } : {}) };
    });
    const bytes = Buffer.from(JSON.stringify(doc)), digest = blobHash(bytes), pin = join(f.dataDir, crypto.randomUUID());
    await writeFile(join(directory, "manifest.json"), bytes, { mode: 0o600 }); await writeFile(pin, JSON.stringify({ manifestSha256: digest }), { mode: 0o600 });
    return { directory, digest, pin, proof: await checkpointProof(directory, digest, pin) };
  };
  const before = await capture();
  const settings = { id, target, proof: before.proof, attestTarget, timeoutMs: 30000, startupTimeoutMs: 120000 };
  const operate = (action: Parameters<typeof migrateStorage>[3]["action"], store = targetStore, proof = before.proof, startupTimeoutMs = settings.startupTimeoutMs) =>
    migrateStorage(f.admin, f.store, store, { ...settings, action, proof, startupTimeoutMs });
  const intent = async (migrationId = id) => (await f.admin<MigrationIntent[]>`SELECT * FROM control.blob_storage_migration WHERE id=${migrationId}`)[0]!;
  const serve = async (store: BindingStore = targetStore) => {
    const runtime = createPool(f.url, 1), app = await testApp(runtime, { blobStore: store }, cleanup => cleanups.push(cleanup));
    try {
      for (const actor of actors) {
        const response = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspace}/blobs/${actor.id}`, { headers: { authorization: `Bearer ${actor.key}` } }));
        expect(response.status).toBe(200); expect(await response.text()).toBe(actor.principalId);
      }
      const first = actors[0]!;
      const sql = await app.handle(new Request(`http://localhost/api/v1/workspaces/${workspace}/sql`, { method: "POST",
        headers: { authorization: `Bearer ${first.key}`, "x-backplane-run": first.runId, "content-type": "application/json" },
        body: JSON.stringify({ statement: "SELECT proof FROM migration_proof WHERE id=1", params: [] }) }));
      expect(sql.status).toBe(200); expect((await sql.json()).rows).toEqual([{ proof: "preserved" }]);
    } finally { await runtime.close(); }
  };
  return { ...f, workspace, actors, targetStore, target, id, retained, before, bucketRequest, capture, operate, intent, serve, freshTarget,
    eraseTargetMarker: () => new S3Client(options).delete(".backplane-store"),
    close: async () => {
      const failures: unknown[] = [];
      for (const cleanup of [...cleanups, () => f.close()]) {
        try { await cleanup(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw failures[0];
    } };
  } catch (error) {
    await Promise.allSettled(cleanups.map(cleanup => cleanup()));
    await f.close().catch(() => {});
    throw error;
  }
}
