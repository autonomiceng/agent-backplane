import { expect, spyOn, test } from "bun:test";
import { Dir } from "node:fs";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesystemStore } from "./filesystem-store.ts";
import { storeMarker } from "./storage-binding.ts";

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


test("failed blob and marker reads leave absent store directories untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "bp-blob-read-")), store = filesystemStore(root);
  try {
    await expect(store.open(crypto.randomUUID(), crypto.randomUUID())).rejects.toThrow();
    await expect(store.readMarker()).rejects.toThrow();
    await expect(Array.fromAsync(store.inventory())).rejects.toThrow();
    await store.remove(crypto.randomUUID(), { id: crypto.randomUUID(), staging: false });
    expect(await store.scanPage(crypto.randomUUID())).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("private marker survives a filesystem recovery copy and stays outside cleanup inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "bp-blob-copy-")), store = filesystemStore(root);
  const workspace = crypto.randomUUID(), id = crypto.randomUUID(), bytes = Buffer.from("restore proof");
  try {
    await store.stage(workspace, id, bytes); await store.promote(workspace, id, bytes);
    await writeFile(join(root, "blobs", storeMarker), "private marker", { mode: 0o600 });
    expect(await Array.fromAsync(store.inventory())).toEqual([{ workspace, id }]);
    expect(await store.scanPage(workspace)).toEqual([{ id, staging: false }]);
    const restored = join(root, "restored");
    await cp(join(root, "blobs"), join(restored, "blobs"), { recursive: true });
    const copy = filesystemStore(restored);
    expect(await copy.readMarker()).toEqual(Buffer.from("private marker"));
    expect(await copy.open(workspace, id)).toEqual(bytes);
    await copy.remove(workspace, { id, staging: false });
    expect(await copy.readMarker()).toEqual(Buffer.from("private marker"));
    expect(await store.open(workspace, id)).toEqual(bytes);
    const staged = crypto.randomUUID();
    await store.stage(workspace, staged, bytes);
    expect(await Array.fromAsync(store.inventory())).toContainEqual({ workspace, id: staged, staging: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("exclusive marker publication preserves the winner and survives interrupted candidate writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bp-marker-publish-")), store = filesystemStore(root);
  try {
    expect(await store.markerOrAbsent()).toBe(null);
    const results = await Promise.allSettled([store.publishMarker(Buffer.from("one")), store.publishMarker(Buffer.from("two"))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const winner = await store.readMarker();
    expect(["one", "two"]).toContain(Buffer.from(winner).toString());
    await store.publishMarker(winner);
    expect(await store.readMarker()).toEqual(winner);
    expect(await Array.fromAsync(store.inventory())).toEqual([]);
    const drafts = await readdir(join(root, ".blob-binding-intents"));
    expect(drafts.length).toBe(3);
    await writeFile(join(root, ".blob-binding-intents", crypto.randomUUID()), "partial", { mode: 0o600 });
    await store.publishMarker(winner);
    expect(await store.readMarker()).toEqual(winner);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("checkpoint archive dereferences marker hard links into safe regular files", async () => {
  const root = await mkdtemp(join(tmpdir(), "bp-marker-archive-")), store = filesystemStore(join(root, "source"));
  try {
    await store.publishMarker(Buffer.from("checkpoint marker"));
    const archive = join(root, "server-data.tar");
    const capture = Bun.spawn(["tar", "--hard-dereference", "-C", join(root, "source"), "-cf", archive, "."], { stdout: "pipe", stderr: "pipe" });
    expect(await capture.exited).toBe(0);
    const inspect = Bun.spawn(["python3", "-c", "import tarfile,sys; a=tarfile.open(sys.argv[1]); assert all(m.isfile() or m.isdir() for m in a); assert a.extractfile('./blobs/.backplane-store').read()==b'checkpoint marker'", archive], { stdout: "pipe", stderr: "pipe" });
    expect(await inspect.exited).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
