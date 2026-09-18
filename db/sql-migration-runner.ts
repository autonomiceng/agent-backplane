import type { SQL } from "bun";
import type { AppliedMigration, Migration, MigrationRunner } from "./migrations.ts";

// Postgres adapter for migrate(). The whole session runs in one transaction under an advisory lock,
// so concurrent server starts serialize and the loser sees the winner's ledger instead of racing it.
// The version table is created by migration 000001, so the first session tolerates its absence.
const LOCK_KEY = 0x62_70_6d_69; // "bpmi"

export function sqlMigrationRunner(sql: SQL): MigrationRunner {
  return {
    locked: (fn) =>
      sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
        return fn({
          async applied(): Promise<AppliedMigration[]> {
            const [exists] = await tx`SELECT to_regclass('control.schema_version') IS NOT NULL AS ok`;
            if (!exists?.ok) return [];
            return tx`SELECT version, name FROM control.schema_version`;
          },
          async apply(m: Migration) {
            await tx.unsafe(m.sql);
            await tx`INSERT INTO control.schema_version (version, name) VALUES (${m.version}, ${m.name})`;
          },
        });
      }),
  };
}
