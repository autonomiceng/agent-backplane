import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { blobHash } from "./blob-store.ts";
export type Snapshot = { systemId: string; timeline: number; postgres: string; schema: number; pgmq: string; heads: { workspaceId: string; head: string }[] };
type Manifest = {
  version: number; captureMode: string; name: string; completedAt: string; before: Snapshot; after: Snapshot;
  artifacts: Record<string, { sha256: string; bytes: number }>;
  storage: { databaseId: string; storeId: string; generation: string; backend: string; phase: string; inventorySha256: string; objectCount: number };
  rustfsExitCode?: number;
  migration?: { id: string; phase: string };
};
const hash = /^[a-f0-9]{64}$/;
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
export async function checkpointProof(directory: string, expected: string, pinFile: string) {
  if (!hash.test(expected)) throw new Error("blob_binding_checkpoint_invalid");
  const regular = async (path: string) => { const stat = await lstat(path); if (!stat.isFile() || stat.nlink !== 1) throw new Error("blob_binding_checkpoint_invalid"); return stat; };
  if (!(await lstat(directory)).isDirectory()) throw new Error("blob_binding_checkpoint_invalid");
  if ((await regular(join(directory, "manifest.json"))).size > 16 * 1024 * 1024) throw new Error("blob_binding_checkpoint_invalid");
  const bytes = await readFile(join(directory, "manifest.json"));
  if (blobHash(bytes) !== expected) throw new Error("blob_binding_checkpoint_hash");
  const doc = JSON.parse(bytes.toString()) as Manifest;
  const pinStat = await regular(pinFile);
  if (pinStat.size > 4096 || pinStat.mode & 0o077) throw new Error("blob_binding_checkpoint_pin");
  const pin = JSON.parse(await readFile(pinFile, "utf8")) as { manifestSha256: string };
  if (pin.manifestSha256 !== expected) throw new Error("blob_binding_checkpoint_pin");
  if (doc.version !== 1 || doc.captureMode !== "offline" || !doc.completedAt || canonical(doc.before) !== canonical(doc.after)
    || doc.storage?.phase !== "ready" || !hash.test(doc.storage.inventorySha256)
    || !doc.artifacts || !["postgres/base.tar", "postgres/pg_wal.tar", "postgres/backup_manifest", "server-data.tar", "server-image.tar"].every(name => name in doc.artifacts)
    || doc.storage.backend === "s3" && (!("rustfs-data.tar" in doc.artifacts) || doc.rustfsExitCode !== 0)) throw new Error("blob_binding_checkpoint_invalid");
  const found: string[] = [];
  const walk = async (path: string, prefix = "") => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), name + "/");
      else if (entry.isFile()) { if (name !== "manifest.json") found.push(name); }
      else throw new Error("blob_binding_checkpoint_invalid");
    }
  };
  await walk(directory);
  if (canonical(found.sort()) !== canonical(Object.keys(doc.artifacts).sort())) throw new Error("blob_binding_checkpoint_artifacts");
  for (const name of found) {
    const artifact = doc.artifacts[name];
    if (!artifact || !hash.test(artifact.sha256) || !Number.isSafeInteger(artifact.bytes)) throw new Error("blob_binding_checkpoint_invalid");
    const path = join(directory, name), stat = await regular(path);
    if (stat.size !== artifact.bytes) throw new Error("blob_binding_checkpoint_artifacts");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    if (digest.digest("hex") !== artifact.sha256) throw new Error("blob_binding_checkpoint_artifacts");
  }
  return { doc, manifestSha256: expected, artifactsSha256: blobHash(Buffer.from(canonical(doc.artifacts))) };
}
