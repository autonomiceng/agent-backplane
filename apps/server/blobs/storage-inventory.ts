// Read-only complete content proof, shared by startup and the fenced operator command.
import type { RunTransaction } from "../runs/with-run-context.ts";
import { blobHash } from "./blob-store.ts";
import type { BindingStore } from "./storage-binding.ts";
export type StoredObject = { workspace: string; id: string; staging?: boolean };
export const objectKey = (ref: StoredObject) => `${ref.workspace}/${ref.staging ? "staging/" : ""}${ref.id}`;
export async function storageInventory(tx: RunTransaction, store: BindingStore, allowUnreferenced = false, allowAbsent = false) {
  const references = await tx<{ workspace: string; id: string; size: number; hash: string }[]>`
    SELECT workspace_id AS workspace,id,size::int,encode(sha256,'hex') AS hash FROM control.blobs`;
  const retained = await tx<{ workspace: string; id: string; staging: boolean; size: number; hash: string }[]>`
    SELECT workspace_id AS workspace,id,staging,size,sha256 AS hash FROM control.blob_storage_retained`;
  const expected = new Map([...references, ...retained].map(ref => [objectKey(ref), ref]));
  if (expected.size !== references.length + retained.length) throw new Error("blob_binding_inventory_mismatch");
  const objects: (StoredObject & { size: number; hash: string; classification: "referenced" | "retained" | "unreferenced" })[] = [];
  const seen = new Set<string>(), live = new Set(references.map(objectKey));
  for await (const ref of store.inventory(allowAbsent)) {
    const key = objectKey(ref), row = expected.get(key);
    if (seen.has(key)) throw new Error("blob_binding_inventory_mismatch");
    seen.add(key);
    const bytes = ref.staging ? await store.readStored(ref.workspace, { id: ref.id, staging: true }) : await store.open(ref.workspace, ref.id);
    const hash = blobHash(bytes);
    if (row && (bytes.length !== row.size || hash !== row.hash)) throw new Error("blob_binding_content_mismatch");
    if (!row && !allowUnreferenced) throw new Error("blob_binding_inventory_mismatch");
    objects.push({ ...ref, size: bytes.length, hash, classification: live.has(key) ? "referenced" : row ? "retained" : "unreferenced" });
  }
  if ([...expected.keys()].some(key => !seen.has(key))) throw new Error("blob_binding_inventory_mismatch");
  objects.sort((a, b) => objectKey(a) < objectKey(b) ? -1 : objectKey(a) > objectKey(b) ? 1 : 0);
  const digest = blobHash(Buffer.from(JSON.stringify(objects.map(ref => [objectKey(ref), ref.size, ref.hash]))));
  return { objects, digest };
}
