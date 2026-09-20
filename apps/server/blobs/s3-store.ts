// Explicit S3 storage uses private Workspace prefixes and a rotating, bounded listing.
import { S3Client } from "bun";
import { blobUuid, bufferBlob, type BlobRef } from "./blob-store.ts";
import { storeMarker, type BindingStore } from "./storage-binding.ts";
export function s3Store(options: ConstructorParameters<typeof S3Client>[0]) {
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
  const list = async (prefix: string, continuationToken?: string) => {
    const deadline = Promise.withResolvers<never>(), timer = setTimeout(() => deadline.reject(new Error("blob_timeout")), 10000);
    return Promise.race([client.list({ prefix, maxKeys: 64,
      ...(continuationToken ? { continuationToken } : {}) }), deadline.promise]).finally(() => clearTimeout(timer));
  };
  return {
    backend: "s3" as const,
    async createStored(workspace: string, ref: BlobRef, bytes: Uint8Array) {
      const name = key(workspace, ref.id, ref.staging);
      const response = await fetch(client.presign(name, { method: "PUT", expiresIn: 60 }), {
        method: "PUT", headers: { "If-None-Match": "*" }, body: Buffer.from(bytes), redirect: "error", signal: AbortSignal.timeout(10000),
      });
      await response.body?.cancel();
      if (!response.ok && response.status !== 412) throw new Error("blob_binding_copy_failed");
      if (!Buffer.from(bytes).equals(await transfer(name, "GET"))) throw new Error("blob_binding_copy_conflict");
    },
    readMarker: () => transfer(storeMarker, "GET"),
    async markerOrAbsent(signal?: AbortSignal) {
      const response = await fetch(client.presign(storeMarker, { method: "GET", expiresIn: 60 }), { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), redirect: "error" });
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw new Error("blob_unavailable"); }
      const result = await bufferBlob(response.body);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    async publishMarker(bytes) {
      const response = await fetch(client.presign(storeMarker, { method: "PUT", expiresIn: 60 }), {
        method: "PUT", headers: { "If-None-Match": "*" }, body: Buffer.from(bytes), redirect: "error", signal: AbortSignal.timeout(10000),
      });
      await response.body?.cancel();
      if (!response.ok && response.status !== 412) throw new Error("blob_binding_publication_failed");
      if (!Buffer.from(bytes).equals(await transfer(storeMarker, "GET"))) throw new Error("blob_binding_marker_mismatch");
    },
    readStored: (workspace, ref) => transfer(key(workspace, ref.id, ref.staging), "GET"),
    async *inventory() {
      let token: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await list("", token);
        for (const { key: name } of page.contents ?? []) {
          if (name === storeMarker) continue;
          const match = /^([^/]+)\/(staging\/)?([^/]+)$/.exec(name), workspace = match?.[1], id = match?.[3];
          if (!workspace || !id || !blobUuid.test(workspace) || !blobUuid.test(id)) throw new Error("blob_inventory_invalid");
          yield { workspace, id, ...(match?.[2] ? { staging: true } : {}) };
        }
        token = page.nextContinuationToken;
        if (page.isTruncated && !token || token && seen.has(token)) throw new Error("blob_inventory_invalid");
        if (token) seen.add(token);
      } while (token);
    },
    async stage(workspace, id, bytes) { await transfer(key(workspace, id, true), "PUT", bytes); },
    async promote(workspace, id, bytes) { await transfer(key(workspace, id), "PUT", bytes); await transfer(key(workspace, id, true), "DELETE"); },
    open: (workspace, id) => transfer(key(workspace, id), "GET"),
    async remove(workspace, ref) { await transfer(key(workspace, ref.id, ref.staging), "DELETE"); },
    async scanPage(workspace) {
      key(workspace, workspace);
      // Native listing cannot abort; a late read has no effects and cannot advance this cursor.
      const page = await list(`${workspace}/`, cursors.get(workspace));
      if (page.nextContinuationToken) cursors.set(workspace, page.nextContinuationToken); else cursors.delete(workspace);
      return (page.contents ?? []).flatMap(({ key: name }) => {
        const match = new RegExp(`^${workspace}/(staging/)?([0-9a-f-]+)$`).exec(name);
        return match && match[2] && blobUuid.test(match[2]) ? [{ id: match[2], staging: Boolean(match[1]) }] : [];
      });
    },
  } satisfies BindingStore & { createStored(workspace: string, ref: BlobRef, bytes: Uint8Array): Promise<void> };
}
