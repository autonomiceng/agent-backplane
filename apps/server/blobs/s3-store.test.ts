import { expect, spyOn, test } from "bun:test";
import { S3Client } from "bun";
import { s3Store } from "./s3-store.ts";

test("incomplete or repeated S3 pagination and mid-list failures cannot certify an empty store", async () => {
  const store = s3Store({ endpoint: "http://127.0.0.1:1", bucket: "proof", accessKeyId: "unused", secretAccessKey: "unused" });
  // These malformed pagination and transport failure points cannot be induced reliably in RustFS.
  const list = spyOn(S3Client.prototype, "list");
  try {
    list.mockResolvedValue({ isTruncated: true });
    await expect(Array.fromAsync(store.inventory())).rejects.toThrow("blob_inventory_invalid");
    list.mockResolvedValue({ isTruncated: true, nextContinuationToken: "repeated" });
    await expect(Array.fromAsync(store.inventory())).rejects.toThrow("blob_inventory_invalid");
    list.mockResolvedValueOnce({ isTruncated: true, nextContinuationToken: "first" });
    list.mockRejectedValueOnce(new Error("listing_failed"));
    await expect(Array.fromAsync(store.inventory())).rejects.toThrow("listing_failed");
  } finally { list.mockRestore(); }
});
