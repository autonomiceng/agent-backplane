import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { adminUrl } from "../testing/postgres.ts";
import { applyMigration, migrationFixture } from "../testing/session.ts";
import type { PreviewResponse } from "./preview-migration-input.ts";

test("lock timeout is ignored, failed DDL survives rollback, or created and dropped relation locks and index audit targets are omitted", async () => {
  const { pool, url, app, key, runId, workspaceId, schema, preview, sql } = await migrationFixture();
  const admin = createPool(adminUrl(url));
  try {
    await applyMigration(app, key, runId, workspaceId, "CREATE TABLE items (id int PRIMARY KEY, note text); CREATE INDEX note_idx ON items (note)");
    expect((await sql("INSERT INTO items (id, note) VALUES (1, 'original')")).status).toBe(200);
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // The holder only reads and locks; fixture data is written through the server.
    const holder = admin.begin(async (tx) => {
      await tx`SELECT id FROM ${tx(schema)}.items WHERE id = 1 FOR UPDATE`;
      locked.resolve(); await release.promise;
    });
    try {
      await Promise.race([locked.promise, holder]);
      const started = performance.now();
      const response = await preview("CREATE TABLE transient (id int); UPDATE items SET note = 'blocked' WHERE id = 1", true, 1);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(response.status).toBe(408);
      expect(await response.json()).toEqual({ error: "sql_lock_timeout", sqlstate: "55P03" });
    } finally { release.resolve(); await holder; }
    expect(await admin<{ note: string }[]>`SELECT note FROM ${admin(schema)}.items`).toEqual([{ note: "original" }]);
    expect(await pool`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname = 'transient'`).toHaveLength(0);
    const response = await preview("CREATE TABLE transient (id int); INSERT INTO transient (id) VALUES (1)", false, 1);
    expect(response.status).toBe(200);
    const body = await response.json() as PreviewResponse;
    expect(body.locks.find((lock) => lock.relation === "transient")?.modes).toContain("AccessExclusiveLock");
    expect(body.locks.find((lock) => lock.relation === "transient")?.modes).toContain("RowExclusiveLock");
    expect(body.elapsedMs).toBeGreaterThan(0);
    const dropped = await preview("DROP TABLE items", true, 1);
    expect(dropped.status).toBe(200);
    expect((await dropped.json() as PreviewResponse).locks.find((lock) => lock.relation === "items")?.modes)
      .toContain("AccessExclusiveLock");
    const commentedIndex = await preview("COMMENT ON INDEX items_pkey IS 'private'", false, 1);
    expect(commentedIndex.status).toBe(200);
    const commented = await commentedIndex.json() as PreviewResponse;
    expect(await pool<{ objects: string[] }[]>`SELECT objects FROM audit.events WHERE workspace_id = ${workspaceId}
      AND position = ${commented.previewPosition}::bigint`).toEqual([{ objects: ["items"] }]);
    const droppedIndex = await preview("DROP INDEX note_idx", true, 1);
    expect(droppedIndex.status).toBe(200);
    const indexBody = await droppedIndex.json() as PreviewResponse;
    expect(indexBody.locks.find((lock) => lock.relation === "note_idx")?.modes).toContain("AccessExclusiveLock");
    expect(await pool<{ objects: string[] }[]>`SELECT objects FROM audit.events WHERE workspace_id = ${workspaceId}
      AND position = ${indexBody.previewPosition}::bigint`).toEqual([{ objects: ["items"] }]);
    expect(await pool`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname = 'transient'`).toHaveLength(0);
  } finally { await admin.close(); await pool.close(); }
});
