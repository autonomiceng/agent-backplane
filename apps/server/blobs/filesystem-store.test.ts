import { expect, spyOn, test } from "bun:test";
import { Dir } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesystemStore } from "./filesystem-store.ts";

test("failed directory read closes the cached scan so retry can enumerate blobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "bp-blob-scan-"));
  const store = filesystemStore(root), workspace = crypto.randomUUID(), id = crypto.randomUUID();
  let readFailed: (() => Promise<unknown>) | undefined;
  const read = spyOn(Dir.prototype, "read");
  try {
    await store.stage(workspace, id, Buffer.from("staged"));
    read.mockImplementationOnce(function (this: Dir) { readFailed = async () => this.read(); return Promise.reject(new Error("read_failed")); });
    await expect(store.scanPage(workspace)).rejects.toThrow("read_failed");
    read.mockRestore();
    if (!readFailed) throw new Error("failed directory missing");
    await expect(readFailed()).rejects.toThrow();
    expect(await store.scanPage(workspace)).toEqual([{ id, staging: true }]);
  } finally { read.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
