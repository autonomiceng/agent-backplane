import { expect, test } from "bun:test";
import { adoptionFixture } from "./testing/storage-adoption-fixture.ts";
import { storageInventory } from "./storage-inventory.ts";
test("inventory distinguishes referenced/staged bytes and rejects a duplicate enumeration", async () => {
  const f = await adoptionFixture();
  try {
    const blob = await f.writeBlob();
    await f.store.stage(blob.workspaceId, blob.id, Buffer.from("stage"));
    const proof = await f.admin.begin(tx => storageInventory(tx, f.store, true));
    expect(proof.objects.map(ref => ref.classification).sort()).toEqual(["referenced", "unreferenced"]);
    // Repeated pagination is a remote failure point, independent of native filesystem enumeration.
    await expect(f.admin.begin(tx => storageInventory(tx, { ...f.store, async *inventory() {
      yield { workspace: blob.workspaceId, id: blob.id }; yield { workspace: blob.workspaceId, id: blob.id };
    } }, true))).rejects.toThrow("blob_binding_inventory_mismatch");
  } finally { await f.close(); }
});
