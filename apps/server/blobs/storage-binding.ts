// Startup verification only. The caller holds this session until serving and purge have stopped.
import type { Pool } from "../platform/pool.ts";
import { blobUuid, type BlobRef, type BlobStore } from "./blob-store.ts";
import { storageLease } from "./storage-lease.ts";
import { storageInventory, type StoredObject } from "./storage-inventory.ts";

export const storeMarker = ".backplane-store";
export type BindingStore = BlobStore & {
  backend: "filesystem" | "s3";
  readMarker(): Promise<Uint8Array>;
  markerOrAbsent(signal?: AbortSignal): Promise<Uint8Array | null>;
  publishMarker(bytes: Uint8Array): Promise<void>;
  readStored(workspace: string, ref: BlobRef): Promise<Uint8Array>;
  inventory(allowAbsent?: boolean): AsyncIterable<StoredObject>;
};
export type Binding = { database_id: string; store_id: string; generation: string; backend: string; phase: string };
export const bindingBytes = (binding: Binding) => Buffer.from(`backplane-blob-store-v1\n${binding.database_id}\n${binding.store_id}\n${binding.generation}\n${binding.backend}\n`);
class BindingError extends Error {}
const refuse = (code: string): never => { throw new BindingError(`blob_binding_${code}`); };

export async function verifyStorageBinding(pool: Pool, store: BindingStore, onLeaseLost?: () => void): Promise<() => Promise<void>> {
  const lease = await storageLease(pool).catch(error => refuse(error instanceof Error && error.message === "blob_binding_busy" ? "busy" : "unavailable"));
  try {
    await lease.session.begin(async tx => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      const rows = await tx<Binding[]>`SELECT database_id,store_id,generation,backend,phase FROM control.blob_storage_binding`;
      if (!rows.length) refuse("required");
      const binding = rows[0];
      if (rows.length !== 1 || !binding) return refuse("ambiguous");
      if (binding.phase !== "ready") refuse("not_ready");
      if (![binding.database_id, binding.store_id, binding.generation].every(value => blobUuid.test(value))) refuse("invalid");
      if (binding.backend !== store.backend) refuse("backend_mismatch");
      const marker = await store.markerOrAbsent();
      if (!marker) return refuse("marker_missing");
      if (!bindingBytes(binding).equals(marker)) refuse("marker_mismatch");
      await storageInventory(tx, store);
    });
    await lease.assertOwned();
    if (onLeaseLost) lease.watch(onLeaseLost);
    return lease.release;
  } catch (error) {
    // Refusal remains authoritative if a disconnected session also fails cleanup.
    await lease.release().catch(() => {});
    if (error instanceof BindingError || error instanceof Error && /^blob_binding_(inventory_mismatch|content_mismatch)$/.test(error.message)) throw error;
    if (error instanceof Error && error.message === "blob_inventory_invalid") return refuse("store_invalid");
    return refuse("unavailable");
  }
}
