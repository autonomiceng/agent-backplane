import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, readdir, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRunContext } from "../runs/with-run-context.ts";
import { testApp, applyMigration, migrationFixture, signUp } from "../testing/session.ts";
import { createMigrationProjection } from "./migration-projection.ts";
import type { ProjectionResponse } from "./rebuild-migration-projection-input.ts";

test("Projection failure changes a committed Migration or prevents ledger-driven repair", async () => {
  const f = await migrationFixture(), directory = await mkdtemp(join(tmpdir(), "bp-projection-"));
  const logs: unknown[] = [];
  try {
    const logger = { error: (value: unknown) => { logs.push(value); } };
    let projection = createMigrationProjection(f.pool, directory, logger, null);
    let projected: ReturnType<typeof projection.project> | undefined;
    const app = await testApp(f.pool, { migrationProjection: { project: (context) => projected = projection.project(context) } });
    const url = `http://localhost/api/v1/workspaces/${f.workspaceId}/migrations`, root = join(directory, "projections", f.workspaceId);
    const rebuild = (headers: Record<string, string> = { cookie: f.cookie }) => app.handle(new Request(`${url}/projection`, {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", ...headers }, body: "{}",
    }));
    expect((await rebuild({ cookie: f.cookie, authorization: `Bearer ${f.key}` })).status).toBe(403);
    expect((await rebuild({ cookie: f.cookie, "x-backplane-run": f.runId })).status).toBe(403);
    expect((await rebuild({})).status).toBe(401);
    const outsider = await signUp(f.app, "projection-outsider@example.com");
    const [outsiderUser] = await f.pool<{ id: string }[]>`SELECT id FROM control."user" WHERE email = 'projection-outsider@example.com'`;
    if (!outsiderUser) throw new Error("Outsider User missing");
    await withRunContext(f.pool, { workspaceId: f.workspaceId, userId: outsiderUser.id }, async (tx) => {
      await tx`DELETE FROM control.member WHERE "userId" = ${outsiderUser.id}`;
    });
    expect((await rebuild({ cookie: outsider })).status).toBe(403);
    expect(await f.pool<{ reason: string; user_id: string }[]>`SELECT reason, user_id FROM audit.rejections
      WHERE workspace_id = ${f.workspaceId} AND kind = 'migration.projection_requested'`)
      .toEqual([{ reason: "workspace_forbidden", user_id: outsiderUser.id }]);
    expect(await readdir(directory)).toEqual([]);
    await writeFile(join(directory, "projections"), "blocked");
    const sql = "-- exact café bytes\r\nCREATE TABLE projected (id int);\r\n";
    const applied = await applyMigration(app, f.key, f.runId, f.workspaceId, sql);
    expect(applied.revision).toBe(1);
    expect((await f.sql("SELECT * FROM projected")).status).toBe(200);
    const ledger = await f.pool`SELECT * FROM control.workspace_migrations WHERE workspace_id = ${f.workspaceId}`;
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ sql, revision: 1, applied_by: f.principalId, run_id: f.runId });
    expect(await f.pool<{ principal_id: string; run_id: string }[]>`SELECT principal_id, run_id FROM audit.events WHERE workspace_id = ${f.workspaceId} AND kind = 'migration.applied'`)
      .toEqual([{ principal_id: f.principalId, run_id: f.runId }]);
    await projected;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ workspaceId: f.workspaceId, revision: 1, stage: "files", error: "projection_unavailable" });
    await rm(join(directory, "projections"));
    const repaired = await rebuild();
    expect(repaired.status).toBe(200);
    expect(await repaired.json()).toMatchObject({ revision: 1, mode: "directory", commit: null });
    projection = createMigrationProjection(f.pool, directory, logger, Bun.which("git", { PATH: Bun.env.PATH ?? "" }));
    const context = { workspaceId: f.workspaceId, principalId: f.principalId, runId: f.runId };
    await chmod(join(directory, "projections"), 0o755);
    expect(await projection.project(context)).toMatchObject({ ok: false, error: "projection_unavailable" });
    await chmod(join(directory, "projections"), 0o700);
    const file = join(root, "migrations", "0001-fixture.sql");
    expect(await readFile(file)).toEqual(Buffer.from(sql));
    const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ workspaceId: f.workspaceId, revision: 1, migrations: [{ sqlHash: applied.sqlHash,
      appliedBy: f.principalId, runId: f.runId, filename: "0001-fixture.sql", appliedAt: applied.appliedAt }] });
    expect(manifest.migrations[0]).not.toHaveProperty("sql");
    const caughtUp = await rebuild();
    expect(caughtUp.status).toBe(200);
    const git = await caughtUp.json() as ProjectionResponse;
    expect(git.mode).toBe("git"); expect(git.commit).toMatch(/^[0-9a-f]{40,64}$/);
    await rm(file);
    await mkdir(file);
    await writeFile(join(root, "migrations", "foreign.txt"), "foreign");
    await writeFile(join(root, "migrations", "9999-stale.sql"), "stale");
    await writeFile(join(root, "manifest.json"), "{}");
    await mkdir(join(root, ".git", "hooks"), { recursive: true });
    await writeFile(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const repeated = await rebuild();
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(git);
    expect(await readFile(file)).toEqual(Buffer.from(sql));
    expect(await readdir(join(root, "migrations"))).toEqual(["0001-fixture.sql"]);
    await applyMigration(app, f.key, f.runId, f.workspaceId, "ALTER TABLE projected ADD COLUMN note text", 1);
    await projected;
    expect(await readFile(join(root, "migrations", "0002-fixture.sql"), "utf8")).toBe("ALTER TABLE projected ADD COLUMN note text");
    expect(await f.pool`SELECT * FROM control.workspace_migrations WHERE workspace_id = ${f.workspaceId} AND revision = 1`).toEqual(ledger);
    const queued = await Promise.all([projection.project(context), projection.project(context), projection.project(context)]);
    expect(queued.every((result) => result.ok && result.response.revision === 2)).toBe(true);
    expect(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")).revision).toBe(2);
    const events = await f.pool<{ user_id: string | null; principal_id: string | null; run_id: string | null }[]>`SELECT user_id, principal_id, run_id FROM audit.events WHERE workspace_id = ${f.workspaceId} AND kind = 'migration.projection_requested'`;
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.user_id && event.principal_id === null && event.run_id === null)).toBe(true);
    const list = await app.handle(new Request(`${url}?limit=1`, { headers: { authorization: `Bearer ${f.key}` } }));
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toMatchObject({ currentRevision: 2, nextAfterRevision: 1, migrations: [{ sql }] });
    const last = await app.handle(new Request(`${url}?afterRevision=1`, { headers: { cookie: f.cookie } }));
    expect(await last.json()).toMatchObject({ currentRevision: 2, nextAfterRevision: null, migrations: [{ revision: 2 }] });
    expect((await app.handle(new Request(url, { headers: { cookie: f.cookie, authorization: "invalid" } }))).status).toBe(401);
  } finally {
    try { await f.pool.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
});
