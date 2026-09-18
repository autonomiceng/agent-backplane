// One statement reads a ledger head and bounded page from the same snapshot.
import type { Pool } from "../platform/pool.ts";
import type { MigrationEntry, listMigrationsInput } from "./list-migrations-input.ts";
export async function listMigrations(pool: Pool, workspaceId: string, input: typeof listMigrationsInput.static, through = 2147483647) {
  const limit = input.limit ?? 50;
  const rows = await pool<((Omit<MigrationEntry, "appliedAt"> & { appliedAt: Date; currentRevision: number }) | { revision: null; currentRevision: number })[]>`
    WITH head AS (SELECT coalesce(max(revision), 0) AS revision FROM control.workspace_migrations WHERE workspace_id = ${workspaceId})
    SELECT h.revision AS "currentRevision", m.workspace_id AS "workspaceId", m.revision, m.name, m.sql,
      encode(m.sql_hash, 'hex') AS "sqlHash", m.statements, m.destructive, m.applied_by AS "appliedBy",
      m.run_id AS "runId", m.applied_at AS "appliedAt"
    FROM head h LEFT JOIN LATERAL (SELECT * FROM control.workspace_migrations WHERE workspace_id = ${workspaceId}
      AND revision > ${input.afterRevision ?? 0} AND revision <= ${through} ORDER BY revision LIMIT ${limit + 1}) m ON true
    ORDER BY m.revision`;
  const migrations = rows.filter((row) => row.revision !== null).map(({ currentRevision: _head, appliedAt, ...row }) =>
    ({ ...row, appliedAt: appliedAt.toISOString() }));
  const more = migrations.length > limit;
  migrations.length = Math.min(migrations.length, limit);
  return { workspaceId: workspaceId.toLowerCase(), currentRevision: rows[0]?.currentRevision ?? 0, migrations,
    nextAfterRevision: more ? migrations.at(-1)?.revision ?? null : null };
}
