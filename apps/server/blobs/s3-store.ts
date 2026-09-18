// Explicit S3 storage uses private Workspace prefixes and a rotating, bounded listing.
import { S3Client } from "bun";
import { blobUuid, bufferBlob, type BlobStore } from "./blob-store.ts";
export function s3Store(options: ConstructorParameters<typeof S3Client>[0]): BlobStore {
  const client = new S3Client(options), cursors = new Map<string, string>();
  const key = (workspace: string, id: string, staging = false) => {
    if (!blobUuid.test(workspace) || !blobUuid.test(id)) throw new Error("invalid_input");
    return `${workspace}/${staging ? "staging/" : ""}${id}`;
  };
  const transfer = async (name: string, method: "PUT" | "GET" | "DELETE", bytes?: Uint8Array) => {
    const response = await fetch(client.presign(name, { method, expiresIn: 60 }), {
      method, ...(bytes ? { body: Buffer.from(bytes) } : {}), signal: AbortSignal.timeout(10000), redirect: "error",
    });
    if (!response.ok && !(method === "DELETE" && response.status === 404)) throw new Error("blob_unavailable");
    if (method === "GET") {
      const result = await bufferBlob(response.body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    }
    await response.body?.cancel(); return new Uint8Array();
  };
  return {
    async stage(workspace, id, bytes) { await transfer(key(workspace, id, true), "PUT", bytes); },
    async promote(workspace, id, bytes) { await transfer(key(workspace, id), "PUT", bytes); await transfer(key(workspace, id, true), "DELETE"); },
    open: (workspace, id) => transfer(key(workspace, id), "GET"),
    async remove(workspace, ref) { await transfer(key(workspace, ref.id, ref.staging), "DELETE"); },
    async scanPage(workspace) {
      key(workspace, workspace);
      // Native listing cannot abort; a late read has no effects and cannot advance this cursor.
      const deadline = Promise.withResolvers<never>(), timer = setTimeout(() => deadline.reject(new Error("blob_timeout")), 10000);
      const page = await Promise.race([client.list({ prefix: `${workspace}/`, maxKeys: 64,
        ...(cursors.has(workspace) ? { continuationToken: cursors.get(workspace) ?? "" } : {}) }), deadline.promise]).finally(() => clearTimeout(timer));
      if (page.nextContinuationToken) cursors.set(workspace, page.nextContinuationToken); else cursors.delete(workspace);
      return (page.contents ?? []).flatMap(({ key: name }) => {
        const match = new RegExp(`^${workspace}/(staging/)?([0-9a-f-]+)$`).exec(name);
        return match && match[2] && blobUuid.test(match[2]) ? [{ id: match[2], staging: Boolean(match[1]) }] : [];
      });
    },
  };
}
