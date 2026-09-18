// Private byte storage; callers serialize mutations under the Workspace Run context.
import { blobError, type BlobResult } from "./blob-result.ts";
export const BLOB_LIMIT = 4194304;
export const blobUuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export type BlobRef = { id: string; staging: boolean };
export type BlobStore = {
  stage(workspace: string, id: string, bytes: Uint8Array): Promise<void>;
  promote(workspace: string, id: string, bytes: Uint8Array): Promise<void>;
  open(workspace: string, id: string): Promise<Uint8Array>;
  remove(workspace: string, ref: BlobRef): Promise<void>;
  scanPage(workspace: string): Promise<BlobRef[]>;
};
export function blobHash(bytes: Uint8Array): string { return new Bun.CryptoHasher("sha256").update(bytes).digest("hex"); }
export async function bufferBlob(stream: ReadableStream<Uint8Array> | null): Promise<BlobResult<Uint8Array>> {
  if (!stream) return { ok: true, value: new Uint8Array() };
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 10000);
  try {
    while (true) {
      const part = await reader.read();
      if (expired) return { ok: false, error: "blob_timeout" };
      if (part.done) break;
      size += part.value.byteLength;
      if (size > BLOB_LIMIT) return { ok: false, error: "blob_too_large" };
      chunks.push(part.value);
    }
    return { ok: true, value: Buffer.concat(chunks, size) };
  } catch (error) { return blobError(error); } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
