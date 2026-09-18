import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { adminUrl, emptyDatabase, migratedDatabase } from "../apps/server/testing/postgres.ts";
import { loadMigrations, migrate } from "./migrations.ts";
import { sqlMigrationRunner } from "./sql-migration-runner.ts";

const MIGRATIONS = new URL("./migrations", import.meta.url).pathname;

describe("sqlMigrationRunner", () => {
  test("applies the repository migrations once and records each version", async () => {
    const sql = new SQL({ url: await emptyDatabase(), max: 1 });
    try {
      const migrations = await loadMigrations(MIGRATIONS);
      const first = await migrate(sqlMigrationRunner(sql), migrations);
      const second = await migrate(sqlMigrationRunner(sql), migrations);
      const rows = await sql`SELECT version FROM control.schema_version ORDER BY version`;
      expect(first).toEqual(migrations.map((m) => m.version));
      expect(second).toEqual([]);
      expect(rows.map((r: { version: number }) => r.version)).toEqual(first);
    } finally {
      await sql.close();
    }
  });

  test("PGMQ initialization and all migrations converge to an unchanged migration ledger", async () => {
    const sql = new SQL({ url: adminUrl(await migratedDatabase()), max: 1 });
    try {
      const migrations = await loadMigrations(MIGRATIONS);
      expect(await migrate(sqlMigrationRunner(sql), migrations)).toEqual([]);
      const rows = await sql`SELECT version FROM control.schema_version ORDER BY version`;
      expect(rows.map((row: { version: number }) => row.version)).toEqual(migrations.map(m => m.version));
      const [installed] = await sql`SELECT to_regnamespace('pgmq') IS NOT NULL AS pgmq`;
      expect(installed?.pgmq).toBe(true);
    } finally {
      await sql.close();
    }
  });

  test("two servers migrating the same empty database at once both succeed, one applying and one skipping", async () => {
    const url = await emptyDatabase();
    const a = new SQL({ url, max: 1 });
    const b = new SQL({ url, max: 1 });
    try {
      const migrations = await loadMigrations(MIGRATIONS);
      const results = await Promise.all([migrate(sqlMigrationRunner(a), migrations), migrate(sqlMigrationRunner(b), migrations)]);
      expect(results.toSorted((x, y) => x.length - y.length)).toEqual([[], migrations.map((m) => m.version)]);
      const [count] = await a`SELECT count(*)::int AS n FROM control.schema_version`;
      expect(count?.n).toBe(migrations.length);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
