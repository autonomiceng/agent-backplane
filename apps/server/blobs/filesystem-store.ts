// The core adapter keeps opaque UUID files private and durably promotes on one filesystem.
import { constants, type Dir } from "node:fs";
import { link, lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BLOB_LIMIT, blobUuid, type BlobRef } from "./blob-store.ts";
import { storeMarker, type BindingStore } from "./storage-binding.ts";

export function filesystemStore(dataDir: string): BindingStore {
  const root = resolve(dataDir, "blobs"), scans = new Map<string, Dir>();
  const sync = async (path: string) => {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  const directory = async (path: string, create = true): Promise<void> => {
    if (path !== dirname(path)) await directory(dirname(path), create);
    if (create) {
      try { await mkdir(path, { mode: 0o700 }); await sync(dirname(path)); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (path.startsWith(root) && (stat.mode & 0o077))) throw new Error("blob_unavailable");
  };
  const path = async (workspace: string, ref: BlobRef, create = true) => {
    if (!blobUuid.test(workspace) || !blobUuid.test(ref.id)) throw new Error("invalid_input");
    await directory(join(root, workspace), create);
    return join(root, workspace, `${ref.id}${ref.staging ? ".stage" : ""}`);
  };
  const read = async (target: string, limit: number, marker = false) => {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.nlink !== 1 && !(marker && stat.nlink === 2)) || stat.size > limit || (stat.mode & 0o077)) throw new Error("blob_unavailable");
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) { const part = await handle.read(bytes, offset, bytes.length - offset, offset); if (!part.bytesRead) throw new Error("blob_unavailable"); offset += part.bytesRead; }
      return bytes;
    } finally { await handle.close(); }
  };
  return {
    backend: "filesystem",
    async readMarker() { await directory(root, false); return read(join(root, storeMarker), 256, true); },
    async markerOrAbsent() {
      try { await directory(root, false); return await read(join(root, storeMarker), 256, true); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error; }
    },
    async publishMarker(bytes) {
      await directory(root);
      const candidates = resolve(dataDir, ".blob-binding-intents");
      await directory(candidates);
      if ((await lstat(candidates)).mode & 0o077) throw new Error("blob_unavailable");
      const candidate = join(candidates, crypto.randomUUID());
      const file = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await sync(candidates);
      try { await link(candidate, join(root, storeMarker)); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
      await sync(root);
      if (!Buffer.from(bytes).equals(await read(join(root, storeMarker), 256, true))) throw new Error("blob_binding_marker_mismatch");
    },
    async readStored(workspace, ref) { return read(await path(workspace, ref, false), BLOB_LIMIT); },
    async *inventory(allowAbsent = false) {
      try { await directory(root, false); }
      catch (error) { if (allowAbsent && error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
      for await (const workspace of await opendir(root)) {
        if (workspace.name === storeMarker) continue;
        if (!blobUuid.test(workspace.name) || !workspace.isDirectory()) throw new Error("blob_inventory_invalid");
        await directory(join(root, workspace.name), false);
        for await (const entry of await opendir(join(root, workspace.name))) {
          const id = entry.name.replace(/\.stage$/, "");
          if (!blobUuid.test(id) || !entry.isFile()) throw new Error("blob_inventory_invalid");
          yield { workspace: workspace.name, id, ...(entry.name.endsWith(".stage") ? { staging: true } : {}) };
        }
      }
    },
    async stage(workspace, id, bytes) {
      const target = await path(workspace, { id, staging: true });
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await sync(dirname(target));
    },
    async promote(workspace, id) {
      const source = await path(workspace, { id, staging: true }), target = await path(workspace, { id, staging: false });
      if (!(await lstat(source)).isFile()) throw new Error("blob_unavailable");
      try { await lstat(target); throw new Error("blob_unavailable"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      await rename(source, target); await sync(dirname(target));
    },
    async open(workspace, id) {
      return read(await path(workspace, { id, staging: false }, false), BLOB_LIMIT);
    },
    async remove(workspace, ref) {
      try { const target = await path(workspace, ref, false); if (!(await lstat(target)).isFile()) throw new Error("blob_unavailable"); await unlink(target); await sync(dirname(target)); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    },
    async scanPage(workspace) {
      try { await path(workspace, { id: workspace, staging: false }, false); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        await directory(root, false);
        return [];
      }
      const dir = scans.get(workspace) ?? await opendir(join(root, workspace)); scans.set(workspace, dir);
      const refs: BlobRef[] = [];
      try {
        for (let n = 0; n < 64; n++) {
          const entry = await dir.read();
          if (!entry) { scans.delete(workspace); await dir.close(); break; }
          const id = entry.name.replace(/\.stage$/, "");
          if (blobUuid.test(id)) refs.push({ id, staging: entry.name.endsWith(".stage") });
        }
        return refs;
      } catch (error) {
        scans.delete(workspace);
        await dir.close().catch(() => {});
        throw error;
      }
    },
  };
}
