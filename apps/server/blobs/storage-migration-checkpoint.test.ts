// Scenario 7: unconditional filesystem custody proof; no database or Docker fixture.
import { expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blobHash } from "./blob-store.ts";
import { checkpointProof } from "./storage-migration-checkpoint.ts";

test("checkpoint custody refuses changed bytes, private pins, artifact sets, nonfiles and unfenced or incomplete S3 captures", async () => {
  const root = await mkdtemp(join(tmpdir(), "migration-custody-")), directory = join(root, "capture"), pin = join(root, "pin.json");
  try {
    await mkdir(join(directory, "postgres"), { recursive: true });
    const content = Buffer.from("custody fixture"), artifacts: Record<string, { sha256: string; bytes: number }> = {};
    for (const name of ["postgres/base.tar", "postgres/pg_wal.tar", "postgres/backup_manifest", "server-data.tar", "server-image.tar"]) {
      await writeFile(join(directory, name), content); artifacts[name] = { sha256: blobHash(content), bytes: content.length };
    }
    const snapshot = { systemId: "1", timeline: 1, postgres: "180000", schema: 35, pgmq: "1.0", heads: [] };
    const doc = { version: 1, captureMode: "offline", name: "capture", completedAt: "2026-09-20T00:00:00Z", before: snapshot, after: snapshot,
      artifacts, storage: { databaseId: crypto.randomUUID(), storeId: crypto.randomUUID(), generation: crypto.randomUUID(), backend: "filesystem",
        phase: "ready", inventorySha256: "a".repeat(64), objectCount: 0 }, rustfsExitCode: 0 };
    const publish = async (value = doc) => {
      const bytes = JSON.stringify(value), digest = blobHash(Buffer.from(bytes));
      await writeFile(join(directory, "manifest.json"), bytes);
      await writeFile(pin, JSON.stringify({ manifestSha256: digest }), { mode: 0o600 });
      return digest;
    };
    let digest = await publish();
    expect((await checkpointProof(directory, digest, pin)).manifestSha256).toBe(digest);
    await expect(checkpointProof(directory, "0".repeat(64), pin)).rejects.toThrow("blob_binding_checkpoint_hash");
    await writeFile(pin, JSON.stringify({ manifestSha256: "0".repeat(64) }));
    await expect(checkpointProof(directory, digest, pin)).rejects.toThrow("blob_binding_checkpoint_pin");
    await publish(); await chmod(pin, 0o644);
    await expect(checkpointProof(directory, digest, pin)).rejects.toThrow("blob_binding_checkpoint_pin");
    await chmod(pin, 0o600); await writeFile(pin, " ".repeat(4097));
    await expect(checkpointProof(directory, digest, pin)).rejects.toThrow("blob_binding_checkpoint_pin");
    await publish();
    const artifact = join(directory, "server-data.tar");
    await writeFile(artifact, Buffer.alloc(content.length));
    await expect(checkpointProof(directory, digest, pin)).rejects.toThrow("blob_binding_checkpoint_artifacts");
    await writeFile(artifact, "short");
    await expect(checkpointProof(directory, digest, pin)).rejects.toThrow("blob_binding_checkpoint_artifacts");
    await writeFile(artifact, content); await writeFile(join(directory, "extra"), "unexpected");
    await expect(checkpointProof(directory, digest, pin)).rejects.toThrow("blob_binding_checkpoint_artifacts");
    await rm(join(directory, "extra")); await rename(artifact, join(root, "retained"));
    await expect(checkpointProof(directory, digest, pin)).rejects.toThrow("blob_binding_checkpoint_artifacts");
    await symlink(join(root, "retained"), artifact);
    await expect(checkpointProof(directory, digest, pin)).rejects.toThrow("blob_binding_checkpoint_invalid");
    await rm(artifact); await rename(join(root, "retained"), artifact);
    digest = await publish({ ...doc, captureMode: "online" });
    await expect(checkpointProof(directory, digest, pin)).rejects.toThrow("blob_binding_checkpoint_invalid");
    digest = await publish({ ...doc, after: { ...snapshot, timeline: 2 } });
    await expect(checkpointProof(directory, digest, pin)).rejects.toThrow("blob_binding_checkpoint_invalid");
    const s3 = { ...doc, storage: { ...doc.storage, backend: "s3" } };
    digest = await publish(s3);
    await expect(checkpointProof(directory, digest, pin)).rejects.toThrow("blob_binding_checkpoint_invalid");
    await writeFile(join(directory, "rustfs-data.tar"), content);
    s3.artifacts = { ...artifacts, "rustfs-data.tar": { sha256: blobHash(content), bytes: content.length } };
    digest = await publish({ ...s3, rustfsExitCode: 1 });
    await expect(checkpointProof(directory, digest, pin)).rejects.toThrow("blob_binding_checkpoint_invalid");
    digest = await publish(s3);
    expect((await checkpointProof(directory, digest, pin)).doc.storage.backend).toBe("s3");
  } finally { await rm(root, { recursive: true, force: true }); }
});
