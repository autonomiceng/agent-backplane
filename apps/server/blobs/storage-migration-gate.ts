import type { SQL } from "bun";
import type { RunTransaction } from "../runs/with-run-context.ts";
export async function migrationGate(query: RunTransaction | SQL, inspect = false) {
  const [intent] = await query<{ id: string; phase: string }[]>`SELECT id,phase FROM control.blob_storage_migration WHERE phase IN ('copying','committed_pending_checkpoint')`;
  if (intent && !inspect) throw new Error("blob_binding_migration_pending");
  return intent ?? null;
}
