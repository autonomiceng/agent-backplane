// The core adapter keeps opaque UUID files private and durably promotes on one filesystem.
import { constants, type Dir } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { BLOB_LIMIT, blobUuid, type BlobRef, type BlobStore } from "./blob-store.ts";

export function filesystemStore(dataDir: string): BlobStore {
  const root = resolve(dataDir, "blobs"), scans = new Map<string, Dir>();
  const sync = async (path: string) => {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  };
  const directory = async (path: string): Promise<void> => {
    if (path !== dirname(path)) await directory(dirname(path));
    try { await mkdir(path, { mode: 0o700 }); await sync(dirname(path)); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (path.startsWith(root) && (stat.mode & 0o077))) throw new Error("blob_unavailable");
  };
  const path = async (workspace: string, ref: BlobRef) => {
    if (!blobUuid.test(workspace) || !blobUuid.test(ref.id)) throw new Error("invalid_input");
    await directory(join(root, workspace));
    return join(root, workspace, `${ref.id}${ref.staging ? ".stage" : ""}`);
  };
  return {
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
      const handle = await open(await path(workspace, { id, staging: false }), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > BLOB_LIMIT || (stat.mode & 0o077)) throw new Error("blob_unavailable");
        const bytes = Buffer.alloc(stat.size); let offset = 0;
        while (offset < bytes.length) { const part = await handle.read(bytes, offset, bytes.length - offset, offset); if (!part.bytesRead) throw new Error("blob_unavailable"); offset += part.bytesRead; }
        return bytes;
      } finally { await handle.close(); }
    },
    async remove(workspace, ref) {
      const target = await path(workspace, ref);
      try { if (!(await lstat(target)).isFile()) throw new Error("blob_unavailable"); await unlink(target); await sync(dirname(target)); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    },
    async scanPage(workspace) {
      await path(workspace, { id: workspace, staging: false });
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
