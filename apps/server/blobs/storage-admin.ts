// Operator entrypoint shared by the one-shot image and fenced offline inspection/reconciliation.
import { parseArgs } from "node:util";
import { writeSync } from "node:fs";
import { createPool } from "../platform/pool.ts";
import { loadBackupAdminUrl } from "../restore/backup-restore.ts";
import { createBlobStore } from "./blob-storage.ts";
import { adoptStorage, type AdoptionOptions } from "./storage-adoption.ts";
export function storageAdminOptions(argv: string[]): AdoptionOptions {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
    fenced: { type: "boolean" }, checkpoint: { type: "string" }, "retain-unreferenced": { type: "boolean" },
  } });
  const mode = positionals[0];
  if (positionals.length !== 1 || mode !== "initialize" && mode !== "reconcile" && mode !== "inspect") throw new Error("blob_binding_usage");
  if ((mode === "initialize" || mode === "inspect") && (values.checkpoint !== undefined || values["retain-unreferenced"] !== undefined)) throw new Error("blob_binding_usage");
  return { mode, fenced: values.fenced ?? false, checkpoint: values.checkpoint ?? "", retain: values["retain-unreferenced"] ?? false };
}
export function storageAdminError(error: unknown) {
  if (error instanceof Error && "errno" in error && (error.errno === "57014" || error.errno === "25P03")) return "blob_binding_inspection_timeout";
  if (error instanceof Error && ["blob_inventory_invalid", "blob_unavailable", "blob_timeout", "invalid_input"].includes(error.message)) return `blob_binding_store_${error.message.replace(/^blob_/, "")}`;
  if (error instanceof Error && "code" in error && typeof error.code === "string" && /^E[A-Z]+$/.test(error.code)) return `blob_binding_operator_${error.code.toLowerCase()}`;
  if (error instanceof Error && /^backup_credential_(file_must_be_private_and_owned|url_invalid)$/.test(error.message)) return "blob_binding_operator_credential_invalid";
  return error instanceof Error && /^blob_binding_[a-z_]+$/.test(error.message) ? error.message : "blob_binding_operator_failed";
}
if (import.meta.main) {
  let pool: ReturnType<typeof createPool> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let inspectionBudget: number | undefined;
  try {
    const options = storageAdminOptions(process.argv.slice(2));
    if (options.mode !== "initialize") {
      const budget = Bun.env.BP_STARTUP_VERIFY_TIMEOUT ?? "120";
      if (!/^[0-9]+$/.test(budget) || Number(budget) < 1 || Number(budget) > 86400) throw new Error("blob_binding_inspection_budget_invalid");
      inspectionBudget = Number(budget) * 1000;
      deadline = setTimeout(() => {
        // Exit the lease-owning process, including when database cleanup is blocked.
        writeSync(2, '{"error":"blob_binding_inspection_timeout"}\n');
        process.exit(1);
      }, inspectionBudget);
    }
    const url = Bun.env.BP_STORAGE_ADMIN_URL_FILE ? await loadBackupAdminUrl(Bun.env.BP_STORAGE_ADMIN_URL_FILE) : Bun.env.BP_ADMIN_DATABASE_URL;
    if (!url || !Bun.env.BP_DATA_DIR) throw new Error("blob_binding_operator_config_required");
    pool = createPool(url, 1);
    const databaseBudget = inspectionBudget === undefined ? undefined : Math.max(1, inspectionBudget - Math.min(5000, inspectionBudget / 2));
    console.log(JSON.stringify(await adoptStorage(pool, createBlobStore(Bun.env, Bun.env.BP_DATA_DIR), options, databaseBudget)));
  } catch (error) { console.error(JSON.stringify({ error: storageAdminError(error) })); process.exitCode = 1; }
  finally { await pool?.close(); clearTimeout(deadline); }
}
