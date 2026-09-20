// Only private installation state changes here. Blob rows and Run provenance remain untouched.
import type { ReservedSQL } from "bun";
import type { Pool } from "../platform/pool.ts";
import type { RunTransaction } from "../runs/with-run-context.ts";
import { bindingBytes, type Binding, type BindingStore } from "./storage-binding.ts";
import { blobHash, type BlobRef } from "./blob-store.ts";
import { canonical, type checkpointProof, type Snapshot } from "./storage-migration-checkpoint.ts";
import { objectKey, storageInventory } from "./storage-inventory.ts";
import { storageLease } from "./storage-lease.ts";
export type MigrationTarget = { project: string; volume: string; bucket: string; endpoint: string; image: string; credentialsSha256: string };
export type MigrationIntent = {
  id: string; phase: "copying" | "committed_pending_checkpoint" | "complete" | "aborted";
  database_id: string; source_store_id: string; source_generation: string; target_store_id: string; target_generation: string;
  checkpoint_sha256: string; artifacts_sha256: string; inventory_sha256: string; snapshot: Snapshot; target: MigrationTarget;
};
type Proof = Awaited<ReturnType<typeof checkpointProof>>;
type TargetStore = BindingStore & { createStored(workspace: string, ref: BlobRef, bytes: Uint8Array): Promise<void> };
export async function migrationSnapshot(tx: RunTransaction) {
  const [row] = await tx<{ snapshot: Snapshot }[]>`SELECT json_build_object('systemId',(pg_control_system()).system_identifier::text,
    'timeline',(pg_control_checkpoint()).timeline_id,'postgres',current_setting('server_version_num'),
    'schema',(SELECT max(version) FROM control.schema_version),'pgmq',(SELECT version FROM pgmq.backplane_install LIMIT 1),
    'heads',(SELECT coalesce(json_agg(json_build_object('workspaceId',workspace_id,'head',last_position::text) ORDER BY workspace_id),'[]') FROM audit.cursor)) AS snapshot`;
  if (!row) throw new Error("blob_binding_snapshot_missing");
  return row.snapshot;
}
function refuse(): never { throw new Error("blob_binding_migration_mismatch"); }
export const migrationBinding = (intent: MigrationIntent, target: boolean): Binding => ({ database_id: intent.database_id,
  store_id: target ? intent.target_store_id : intent.source_store_id, generation: target ? intent.target_generation : intent.source_generation,
  backend: target ? "s3" : "filesystem", phase: "ready" });
export async function migrateStorage(pool: Pool, source: BindingStore, targetStore: TargetStore, options: {
  action: "prepare" | "copy" | "repair" | "abort" | "complete" | "restore-complete"; id: string; target: MigrationTarget; proof: Proof;
  // The operator attests the labeled volume; this callback rechecks credentials and versioning under the lease.
  attestTarget(): Promise<void>; timeoutMs: number; startupTimeoutMs: number; emptyTarget?: boolean;
}) {
  if (!Number.isInteger(options.startupTimeoutMs) || options.startupTimeoutMs < 1000 || options.startupTimeoutMs > 86400000) throw new Error("blob_binding_migration_startup_budget_invalid");
  const repairing = options.action === "repair";
  if (source.backend !== "filesystem" || targetStore.backend !== "s3") refuse();
  const lease = await storageLease(pool);
  try {
    await lease.session`SELECT set_config('statement_timeout',${String(options.timeoutMs)},false),
      set_config('idle_in_transaction_session_timeout',${String(options.timeoutMs)},false)`;
    const fence = async (tx: RunTransaction | ReservedSQL = lease.session) => {
      await lease.assertOwned(tx);
      const [active] = await tx`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename='bp_server' AND pid<>pg_backend_pid()`;
      if (active.count) throw new Error("blob_binding_stop_all_servers");
    };
    await fence();
    let [intent] = await lease.session<MigrationIntent[]>`SELECT * FROM control.blob_storage_migration WHERE id=${options.id}`;
    if (!intent && options.action !== "prepare") refuse();
    const { doc } = options.proof;
    const sourceProof = async (tx: RunTransaction) => {
      const [binding] = await tx<Binding[]>`SELECT * FROM control.blob_storage_binding`;
      const expected = intent ? migrationBinding(intent, false) : binding;
      const liveExpected = repairing && intent ? migrationBinding(intent, true) : expected;
      if (!expected || !liveExpected || expected.backend !== "filesystem" || source.backend !== "filesystem" || expected.phase !== "ready"
        || !binding || !bindingBytes(binding).equals(bindingBytes(liveExpected)) || binding.phase !== "ready"
        || !bindingBytes(expected).equals(await source.readMarker())) refuse();
      if (canonical(await migrationSnapshot(tx)) !== canonical(intent?.snapshot ?? doc.after)) refuse();
      const inventory = await storageInventory(tx, source);
      if (inventory.digest !== (intent?.inventory_sha256 ?? doc.storage.inventorySha256)) refuse();
      if (doc.storage.backend !== "filesystem" || doc.storage.phase !== "ready" || doc.storage.databaseId !== expected.database_id
        || doc.storage.storeId !== expected.store_id || doc.storage.generation !== expected.generation
        || doc.storage.inventorySha256 !== inventory.digest || intent && canonical(doc.after) !== canonical(intent.snapshot)) refuse();
      return { binding, inventory };
    };
    if (intent && (intent.id !== options.id || canonical(intent.target) !== canonical(options.target))) refuse();
    if (options.action === "abort") {
      if (!intent || !["copying", "aborted"].includes(intent.phase)) refuse();
      if (intent.checkpoint_sha256 !== options.proof.manifestSha256 || intent.artifacts_sha256 !== options.proof.artifactsSha256) refuse();
      if (intent.phase === "aborted") return { phase: "aborted", id: intent.id };
      await lease.session.begin(async tx => {
        await tx`LOCK TABLE control.blobs,control.blob_storage_binding,control.blob_storage_retained,control.blob_storage_migration IN SHARE ROW EXCLUSIVE MODE`;
        await sourceProof(tx); await fence(tx);
        if (intent?.phase === "copying") await tx`UPDATE control.blob_storage_migration SET phase='aborted' WHERE id=${options.id} AND phase='copying'`;
      });
      return { phase: "aborted", id: options.id };
    }
    if (options.action !== "prepare") await options.attestTarget();
    if (options.action === "complete" || options.action === "restore-complete") {
      if (!intent || !["committed_pending_checkpoint", "complete"].includes(intent.phase)) refuse();
      const current = intent;
      await lease.session.begin(async tx => {
        await tx`LOCK TABLE control.blobs,control.blob_storage_binding,control.blob_storage_retained,control.blob_storage_migration IN SHARE ROW EXCLUSIVE MODE`;
        const [binding] = await tx<Binding[]>`SELECT * FROM control.blob_storage_binding`;
        const expected = migrationBinding(current, true);
        if (!binding || binding.phase !== "ready" || !bindingBytes(binding).equals(bindingBytes(expected))
          || !bindingBytes(expected).equals(await targetStore.readMarker()) || (await storageInventory(tx, targetStore)).digest !== current.inventory_sha256
          || doc.storage.backend !== "s3" || doc.storage.databaseId !== expected.database_id || doc.storage.storeId !== expected.store_id
          || doc.storage.generation !== expected.generation || doc.storage.inventorySha256 !== current.inventory_sha256
          || doc.migration?.id !== current.id || doc.migration.phase !== "committed_pending_checkpoint") refuse();
        const live = await migrationSnapshot(tx);
        if (options.action === "restore-complete") {
          const [gate] = await tx`SELECT backup_id,target_lsn,active FROM control.restore_gate WHERE singleton`;
          if (!gate || gate.backup_id !== doc.name || !gate.target_lsn || live.heads.length && !gate.active
            || canonical({ ...live, timeline: doc.after.timeline }) !== canonical(doc.after)) refuse();
        } else if (canonical(live) !== canonical(doc.after) || canonical(live) !== canonical(current.snapshot)) refuse();
        await fence(tx);
        const [completion] = await tx<{ checkpoint_sha256: string; artifacts_sha256: string }[]>`SELECT * FROM control.blob_storage_migration_completion WHERE migration_id=${current.id}`;
        if (completion) {
          if (completion.checkpoint_sha256 !== options.proof.manifestSha256 || completion.artifacts_sha256 !== options.proof.artifactsSha256) refuse();
        } else {
          await tx`INSERT INTO control.blob_storage_migration_completion(migration_id,checkpoint_sha256,artifacts_sha256)
            VALUES(${current.id},${options.proof.manifestSha256},${options.proof.artifactsSha256})`;
        }
        if (current.phase !== "complete") await tx`UPDATE control.blob_storage_migration SET phase='complete' WHERE id=${current.id} AND phase='committed_pending_checkpoint'`;
      });
      return { phase: "complete", id: current.id };
    }
    if (intent && intent.phase !== (repairing ? "committed_pending_checkpoint" : "copying")) refuse();
    if (intent && (intent.checkpoint_sha256 !== options.proof.manifestSha256 || intent.artifacts_sha256 !== options.proof.artifactsSha256)) refuse();
    const prepared = await lease.session.begin(async tx => {
      await tx`LOCK TABLE control.blobs,control.blob_storage_binding,control.blob_storage_retained,control.blob_storage_migration IN SHARE ROW EXCLUSIVE MODE`;
      if (repairing && intent) {
        const [binding] = await tx<Binding[]>`SELECT * FROM control.blob_storage_binding`;
        const expected = bindingBytes(migrationBinding(intent, true));
        if (!binding || binding.phase !== "ready" || !expected.equals(bindingBytes(binding))
          || canonical(await migrationSnapshot(tx)) !== canonical(intent.snapshot) || canonical(doc.after) !== canonical(intent.snapshot)
          || doc.storage.backend !== "filesystem" || doc.storage.phase !== "ready" || doc.storage.databaseId !== intent.database_id
          || doc.storage.storeId !== intent.source_store_id || doc.storage.generation !== intent.source_generation
          || doc.storage.inventorySha256 !== intent.inventory_sha256) refuse();
        const marker = await targetStore.markerOrAbsent();
        if (marker && !expected.equals(marker)) refuse();
        if (marker) {
          const inventory = await storageInventory(tx, targetStore).catch(error => {
            // Missing entries require the source-backed preflight before any write.
            if (error instanceof Error && error.message === "blob_binding_inventory_mismatch") return null;
            throw error;
          });
          if (inventory) {
            if (inventory.digest !== intent.inventory_sha256) refuse();
            await fence(tx); return null;
          }
        }
      }
      if (!intent) {
        const [occupied] = await tx`SELECT EXISTS(SELECT FROM control.blob_storage_migration WHERE phase <> 'aborted'
          OR target->>'volume'=${options.target.volume}) AS present`;
        if (occupied.present) refuse();
      }
      const proof = await sourceProof(tx);
      if (!intent) {
        if (options.action !== "prepare") refuse();
        await fence(tx);
        const [created] = await tx<MigrationIntent[]>`INSERT INTO control.blob_storage_migration(id,phase,database_id,source_store_id,source_generation,
          target_store_id,target_generation,checkpoint_sha256,artifacts_sha256,inventory_sha256,snapshot,target)
          VALUES(${options.id},'copying',${proof.binding.database_id},${proof.binding.store_id},${proof.binding.generation},
            ${crypto.randomUUID()},${crypto.randomUUID()},${options.proof.manifestSha256},${options.proof.artifactsSha256},${proof.inventory.digest},
            ${JSON.stringify(doc.after)}::text::jsonb,${JSON.stringify(options.target)}::text::jsonb) RETURNING *`;
        if (!created) refuse();
        intent = created;
      }
      return proof.inventory;
    });
    if (!intent) return refuse();
    if (!prepared) return { phase: "committed_pending_checkpoint", id: intent.id };
    if (options.action === "prepare") return { phase: "copying", id: intent.id };
    const current = intent, expectedMarker = bindingBytes(migrationBinding(current, true));
    const marker = await targetStore.markerOrAbsent();
    if (marker && (options.emptyTarget || !expectedMarker.equals(marker))) refuse();
    const expected = new Map(prepared.objects.map(ref => [objectKey(ref), ref])), present = new Set<string>();
    // Validate all partial objects before creating anything on resume.
    for await (const ref of targetStore.inventory()) {
      if (options.emptyTarget || present.has(objectKey(ref))) refuse();
      present.add(objectKey(ref));
      const row = expected.get(objectKey(ref));
      const bytes = await targetStore.readStored(ref.workspace, { id: ref.id, staging: Boolean(ref.staging) });
      if (!row || row.size !== bytes.length || row.hash !== blobHash(bytes)) refuse();
    }
    for (const ref of prepared.objects) {
      if (present.has(objectKey(ref))) continue;
      await fence();
      const physical = { id: ref.id, staging: Boolean(ref.staging) };
      const bytes = await source.readStored(ref.workspace, physical);
      if (bytes.length !== ref.size || blobHash(bytes) !== ref.hash) refuse();
      await targetStore.createStored(ref.workspace, physical, bytes);
    }
    await options.attestTarget();
    await lease.session.begin(async tx => {
      await tx`LOCK TABLE control.blobs,control.blob_storage_binding,control.blob_storage_retained,control.blob_storage_migration IN SHARE ROW EXCLUSIVE MODE`;
      await sourceProof(tx);
      if ((await (repairing ? storageInventory(tx, targetStore) : qualifyTargetInventory(tx, targetStore, options.startupTimeoutMs))).digest !== current.inventory_sha256) refuse();
      await fence(tx);
      const marker = await targetStore.markerOrAbsent();
      if (marker && !expectedMarker.equals(marker)) refuse();
      if (!repairing || !marker) await targetStore.publishMarker(expectedMarker);
      if (!expectedMarker.equals(await targetStore.readMarker())) refuse();
      await sourceProof(tx);
      if ((await (repairing ? storageInventory(tx, targetStore) : qualifyTargetInventory(tx, targetStore, options.startupTimeoutMs))).digest !== current.inventory_sha256) refuse();
      await fence(tx);
      if (repairing) return;
      await tx`UPDATE control.blob_storage_binding SET store_id=${current.target_store_id},generation=${current.target_generation},backend='s3',
        intent_kind=NULL,checkpoint_ref=NULL,retain_unreferenced=false,inventory_sha256=${current.inventory_sha256} WHERE singleton`;
      await tx`UPDATE control.blob_storage_migration SET phase='committed_pending_checkpoint' WHERE id=${current.id} AND phase='copying'`;
    });
    return { phase: "committed_pending_checkpoint", id: current.id };
  } finally { await lease.release(); }
}

// Reserve half the startup budget for setup and variability. Late reads cannot start another request.
async function qualifyTargetInventory(tx: RunTransaction, store: BindingStore, startupTimeoutMs: number) {
  const budget = startupTimeoutMs / 2, started = performance.now();
  let stopped = false;
  const failure = () => new Error("blob_binding_migration_startup_budget");
  const check = () => { if (stopped || performance.now() - started >= budget) throw failure(); };
  const bounded: BindingStore = { ...store,
    async open(workspace, id) { check(); const bytes = await store.open(workspace, id); check(); return bytes; },
    async readStored(workspace, ref) { check(); const bytes = await store.readStored(workspace, ref); check(); return bytes; },
    async *inventory(allowAbsent) {
      check();
      for await (const ref of store.inventory(allowAbsent)) { check(); yield ref; check(); }
    },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proof = await Promise.race([storageInventory(tx, bounded), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { stopped = true; reject(failure()); }, budget);
    })]);
    check(); return proof;
  } finally { stopped = true; clearTimeout(timer); }
}
