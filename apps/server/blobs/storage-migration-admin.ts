// Private file handoff from scripts/storage-migrate.py; never accepts credential argv.
import { createHash, pbkdf2Sync } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import { createPool } from "../platform/pool.ts";
import { loadBackupAdminUrl } from "../restore/backup-restore.ts";
import { filesystemStore } from "./filesystem-store.ts";
import { s3Store } from "./s3-store.ts";
import { checkpointProof } from "./storage-migration-checkpoint.ts";
import { migrateStorage, type MigrationTarget } from "./storage-migration.ts";
import { storageAdminError } from "./storage-admin.ts";
import { blobUuid } from "./blob-store.ts";
if (import.meta.main) {
  let pool: ReturnType<typeof createPool> | undefined;
  const budget = Number(Bun.env.BP_STORAGE_MIGRATION_TIMEOUT ?? "3600");
  if (!Number.isInteger(budget) || budget < 1 || budget > 86400) process.exit(1);
  const deadline = setTimeout(() => { writeSync(2, '{"error":"blob_binding_migration_timeout"}\n'); process.exit(1); }, budget * 1000);
  try {
    if (process.argv.length !== 3) throw new Error("blob_binding_migration_usage");
    const path = process.argv[2]!;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 16384) throw new Error("blob_binding_migration_private_file");
    const request = JSON.parse(await readFile(path, "utf8")) as {
      action: "prepare" | "copy" | "repair" | "abort" | "complete" | "restore-complete"; id: string; target: MigrationTarget;
      checkpoint: string; manifestSha256: string; pin: string; emptyTarget?: boolean;
    };
    if (!["prepare", "copy", "repair", "abort", "complete", "restore-complete"].includes(request.action) || !blobUuid.test(request.id)) throw new Error("blob_binding_migration_usage");
    const required = (key: string) => { const value = Bun.env[key]; if (!value) throw new Error("blob_binding_operator_config_required"); return value; };
    if (request.target.endpoint !== "http://rustfs:9000" || request.target.bucket !== required("BP_BLOB_S3_BUCKET")) throw new Error("blob_binding_migration_mismatch");
    const startupBudget = required("BP_STARTUP_VERIFY_TIMEOUT");
    if (!/^[0-9]+$/.test(startupBudget) || Number(startupBudget) < 1 || Number(startupBudget) > 86400) throw new Error("blob_binding_migration_startup_budget_invalid");
    const url = Bun.env.BP_STORAGE_ADMIN_URL_FILE ? await loadBackupAdminUrl(Bun.env.BP_STORAGE_ADMIN_URL_FILE) : required("BP_ADMIN_DATABASE_URL");
    pool = createPool(url, 1);
    const target = s3Store({ endpoint: request.target.endpoint, bucket: request.target.bucket, region: "us-east-1",
      accessKeyId: required("BP_BLOB_S3_ACCESS_KEY"), secretAccessKey: required("BP_BLOB_S3_SECRET_KEY") });
    const credentials = ["BP_RUSTFS_ROOT_USER", "BP_RUSTFS_ROOT_PASSWORD", "BP_BLOB_S3_ACCESS_KEY", "BP_BLOB_S3_SECRET_KEY"].map(required);
    const commitment = pbkdf2Sync(JSON.stringify([request.id, ...credentials]), createHash("sha256").update(request.id).digest(), 600000, 32, "sha256").toString("hex");
    if (commitment !== request.target.credentialsSha256) throw new Error("blob_binding_migration_credentials");
    const attestTarget = async () => {
      // The helper checks root authentication, scoped account policy and never-enabled versioning.
      const child = Bun.spawn(["bun", "scripts/s3-checkpoint-proof.js"], { stdout: "ignore", stderr: "ignore" });
      if (await child.exited) throw new Error("blob_binding_migration_target_proof");
    };
    console.log(JSON.stringify(await migrateStorage(pool, filesystemStore(required("BP_DATA_DIR")), target, {
      ...request, proof: await checkpointProof(request.checkpoint, request.manifestSha256, request.pin), attestTarget, timeoutMs: Math.max(1, budget * 1000 - 1000), startupTimeoutMs: Number(startupBudget) * 1000,
    })));
  } catch (error) { console.error(JSON.stringify({ error: storageAdminError(error) })); process.exitCode = 1; }
  finally { await pool?.close(); clearTimeout(deadline); }
}
