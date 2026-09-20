// Offline operator control plane. Only private binding/retention state is written.
import type { Pool } from "../platform/pool.ts";
import { bindingBytes, type Binding, type BindingStore } from "./storage-binding.ts";
import { storageInventory } from "./storage-inventory.ts";
import { storageLease } from "./storage-lease.ts";
export type AdoptionOptions = { mode: "initialize" | "adopt" | "reconcile" | "inspect"; fenced: boolean; checkpoint: string; retain: boolean };
type Intent = Binding & { intent_kind: string | null; checkpoint_ref: string | null; retain_unreferenced: boolean; inventory_sha256: string | null };
const mismatch = () => { throw new Error("blob_binding_intent_mismatch"); };
export async function adoptStorage(pool: Pool, store: BindingStore, options: AdoptionOptions) {
  if (options.mode !== "initialize" && (!options.fenced || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(options.checkpoint))) throw new Error("blob_binding_checkpoint_and_fence_required");
  // A repeated bootstrap never writes a ready binding, including when the server is running.
  if (options.mode === "initialize") {
    const rows = await pool<Intent[]>`SELECT * FROM control.blob_storage_binding`;
    if (rows.length === 1 && rows[0]?.phase === "ready") {
      const binding = rows[0];
      if (binding.backend !== store.backend || !bindingBytes(binding).equals(await store.readMarker())) mismatch();
      return { status: "already_bound", verification: "required_at_server_startup" };
    }
  }
  const lease = await storageLease(pool);
  try {
    const checkFence = async () => {
      await lease.assertOwned();
      const [active] = await lease.session`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND usename='bp_server' AND pid<>pg_backend_pid()`;
      if (active.count) throw new Error("blob_binding_stop_all_servers");
    };
    await checkFence();
    const prepared = await lease.session.begin(async tx => {
      await tx`LOCK TABLE control.blobs,control.blob_storage_binding,control.blob_storage_retained IN SHARE ROW EXCLUSIVE MODE`;
      const rows = await tx<Intent[]>`SELECT * FROM control.blob_storage_binding`;
      if (rows.length > 1) throw new Error("blob_binding_ambiguous");
      let intent = rows[0];
      if (intent && (intent.backend !== store.backend || !["ready", "verifying"].includes(intent.phase))) mismatch();
      const marker = await store.markerOrAbsent();
      if (marker && (!intent || !bindingBytes(intent).equals(marker))) mismatch();
      if (intent?.phase === "ready" && !marker) throw new Error("blob_binding_marker_missing");
      const inventory = await storageInventory(tx, store, true, !intent && !marker || intent?.phase === "verifying");
      if (options.mode === "inspect") return { intent, inventory };
      if (!intent && inventory.objects.some(ref => ref.classification === "retained")) mismatch();
      if (options.mode === "initialize") {
        const [data] = await tx`SELECT EXISTS(SELECT FROM control.workspaces) OR EXISTS(SELECT FROM control."user") AS present`;
        if (inventory.objects.length || data.present) throw new Error("blob_binding_explicit_adoption_required");
      }
      if (intent?.phase === "verifying") {
        if (intent.intent_kind !== options.mode || intent.checkpoint_ref !== options.checkpoint || intent.retain_unreferenced !== options.retain
          || intent.inventory_sha256 !== inventory.digest) mismatch();
      } else {
        if (options.mode === "initialize") {
          if (intent || marker) throw new Error("blob_binding_explicit_adoption_required");
        } else if (options.mode === "adopt" && intent || options.mode === "reconcile" && !intent) {
          // A successful command is idempotent only with its exact saved evidence and content.
          if (!intent || intent.intent_kind !== options.mode || intent.checkpoint_ref !== options.checkpoint
            || intent.retain_unreferenced !== options.retain || intent.inventory_sha256 !== inventory.digest) mismatch();
          return { intent, inventory };
        }
        if (inventory.objects.some(ref => ref.classification === "unreferenced") && !options.retain) throw new Error("blob_binding_unreferenced_requires_retention");
        if (!intent) {
          const [created] = await tx<Intent[]>`INSERT INTO control.blob_storage_binding(database_id,store_id,generation,backend,phase)
            VALUES(${crypto.randomUUID()},${crypto.randomUUID()},${crypto.randomUUID()},${store.backend},'verifying') RETURNING *`;
          if (!created) throw new Error("blob_binding_intent_missing");
          intent = created;
        }
        await tx`UPDATE control.blob_storage_binding SET phase='verifying',intent_kind=${options.mode},checkpoint_ref=${options.checkpoint},
          retain_unreferenced=${options.retain},inventory_sha256=${inventory.digest} WHERE singleton`;
        for (const ref of inventory.objects.filter(ref => ref.classification === "unreferenced")) {
          await tx`INSERT INTO control.blob_storage_retained(workspace_id,id,staging,size,sha256)
            VALUES(${ref.workspace},${ref.id},${Boolean(ref.staging)},${ref.size},${ref.hash})`;
        }
      }
      return { intent, inventory };
    });
    if (options.mode === "inspect") return { status: "inspected", ...prepared.inventory, intent: prepared.intent ? {
      phase: prepared.intent.phase, operation: prepared.intent.intent_kind,
      checkpoint: prepared.intent.checkpoint_ref, retainUnreferenced: prepared.intent.retain_unreferenced,
    } : null };
    const intent = prepared.intent;
    if (!intent) throw new Error("blob_binding_intent_missing");
    // The committed intent survives marker publication failure and uncertain completion.
    await checkFence();
    await lease.session.begin(async tx => {
      await tx`LOCK TABLE control.blobs,control.blob_storage_binding,control.blob_storage_retained IN SHARE ROW EXCLUSIVE MODE`;
      const [current] = await tx<Intent[]>`SELECT * FROM control.blob_storage_binding`;
      if (!current || !bindingBytes(current).equals(bindingBytes(intent)) || current.inventory_sha256 !== prepared.inventory.digest
        || current.intent_kind !== options.mode || current.checkpoint_ref !== options.checkpoint || current.retain_unreferenced !== options.retain) mismatch();
      const proof = await storageInventory(tx, store, false, true);
      if (proof.digest !== prepared.inventory.digest) mismatch();
      const marker = await store.markerOrAbsent();
      if (marker && !bindingBytes(intent).equals(marker)) mismatch();
      if (!marker) await store.publishMarker(bindingBytes(intent));
      if (!bindingBytes(intent).equals(await store.readMarker())) mismatch();
      if ((await storageInventory(tx, store)).digest !== proof.digest) mismatch();
      await lease.assertOwned(tx);
      await tx`UPDATE control.blob_storage_binding SET phase='ready' WHERE singleton`;
    });
    return { status: "ready", ...prepared.inventory,
      objects: prepared.inventory.objects.map(ref => ref.classification === "unreferenced" ? { ...ref, classification: "retained" } : ref) };
  } finally { await lease.release(); }
}
