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

test("forward hardening preserves UTC instants and validates workspace references", async () => {
  const sql = new SQL({ url: await emptyDatabase(), max: 1 });
  try {
    const migrations = await loadMigrations(MIGRATIONS);
    await sql`SET TIME ZONE 'Pacific/Auckland'`;
    await migrate(sqlMigrationRunner(sql), migrations.filter(m => m.version <= 30));
    await sql`INSERT INTO control."user" (id,name,email,"createdAt","updatedAt")
      VALUES ('upgrade-proof','Upgrade proof','upgrade@example.invalid','2026-01-02 03:04:05','2026-01-02 03:04:05')`;
    expect(await migrate(sqlMigrationRunner(sql), migrations)).toEqual([31]);
    expect(await migrate(sqlMigrationRunner(sql), migrations)).toEqual([]);
    const [before] = await sql`SELECT extract(epoch FROM "createdAt")::float8 AS instant FROM control."user" WHERE id='upgrade-proof'`;
    expect(before.instant).toBe(Date.UTC(2026, 0, 2, 3, 4, 5) / 1000);
    const [fresh] = await sql`INSERT INTO control."user" (id,name,email)
      VALUES ('timezone-proof','Timezone proof','timezone@example.invalid')
      RETURNING abs(extract(epoch FROM ("createdAt" - now()))) < 1 AS correct`;
    expect(fresh.correct).toBe(true);
    const columns = await sql`SELECT data_type FROM information_schema.columns WHERE table_schema='control'
      AND table_name IN ('user','session','account','verification','organization','member','invitation')
      AND data_type LIKE 'timestamp%'`;
    expect(columns).toHaveLength(16);
    expect(columns.every((row: { data_type: string }) => row.data_type === 'timestamp with time zone')).toBe(true);
    const constraints = await sql`SELECT convalidated, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conname IN ('reconciliations_workspace_delivery_fk','reconciliations_workspace_successor_fk','approvals_workspace_released_delivery_fk')`;
    expect(constraints).toHaveLength(3);
    expect(constraints.every((row: { convalidated: boolean; definition: string }) => row.convalidated && row.definition.includes('FOREIGN KEY (workspace_id,')
      && row.definition.includes('REFERENCES queue.deliveries(workspace_id, id)'))).toBe(true);
  } finally { await sql.close(); }
});
