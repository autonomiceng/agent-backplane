import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigration, migrationFixture } from "../../../apps/server/testing/session.ts";
import { execute } from "./execute.ts";
import type { ApplyInput } from "../../../apps/server/schema/apply-migration-input.ts";
import type { PreviewResponse } from "../../../apps/server/schema/preview-migration-input.ts";

test("Push applies changed source or a stale preview receipt", async () => {
  const f = await migrationFixture(), directory = await mkdtemp(join(tmpdir(), "bp-push-"));
  try {
    const file = join(directory, "change.sql"), sql = "-- café\r\nCREATE TABLE pushed (id int);\r\n";
    await writeFile(file, sql);
    const run = async (afterPreview: (receipt: PreviewResponse) => Promise<PreviewResponse>, flags: string[] = []) => {
      let stdout = "", stderr = "", previews = 0;
      const applies: ApplyInput[] = [], runs: string[] = [];
      const transport: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = new Request(input, init), path = new URL(request.url).pathname;
        if (request.method === "POST" && path.endsWith("/migrations")) {
          applies.push(await request.clone().json() as ApplyInput); runs.push(request.headers.get("x-backplane-run")!);
        }
        const response = await f.app.handle(request);
        if (path.endsWith("/migrations/preview") && response.ok) {
          previews++;
          return Response.json(await afterPreview(await response.json() as PreviewResponse));
        }
        return response;
      }, { preconnect: fetch.preconnect });
      const code = await execute(["push", file, "--name", "push test", ...flags], {
        env: { BP_URL: "http://localhost", BP_KEY: f.key, BP_WORKSPACE_ID: f.workspaceId, BP_DATA_DIR: directory },
        stdin: async () => "", stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; }, transport,
      });
      return { code, stdout, stderr, previews, applies, runs };
    };
    const changed = await run(async (receipt) => { await writeFile(file, "CREATE TABLE changed (id int)"); return receipt; });
    expect(changed).toMatchObject({ code: 1, stdout: "", previews: 1, applies: [] });
    expect(changed.stderr).toContain('"error":"push_source_changed"');
    expect(await f.pool<{ revision: number }[]>`SELECT revision FROM control.workspace_migrations WHERE workspace_id = ${f.workspaceId}`).toHaveLength(0);
    await writeFile(file, sql);
    const stale = await run(async (receipt) => {
      await applyMigration(f.app, f.key, f.runId, f.workspaceId, "CREATE TABLE competing (id int)"); return receipt;
    });
    expect(stale).toMatchObject({ code: 1, stdout: "", previews: 1 });
    expect(stale.applies).toHaveLength(1);
    expect(stale.stderr).toContain('"error":"revision_stale"');
    expect(stale.stderr).toContain('"status":409');
    const incompatible = await run(async (receipt) => ({ ...receipt, previewPosition: "0" }));
    expect(incompatible).toMatchObject({ code: 1, stdout: "", previews: 1 });
    expect(incompatible.applies).toHaveLength(1);
    expect(incompatible.stderr).toContain('"error":"preview_mismatch"');
    expect(await f.pool<{ revision: number }[]>`SELECT revision FROM control.workspace_migrations WHERE workspace_id = ${f.workspaceId}`).toEqual([{ revision: 1 }]);
    let exactReceipt = "";
    const success = await run(async (receipt) => { exactReceipt = receipt.previewPosition; return receipt; }, ["--expected-revision", "1"]);
    expect(success).toMatchObject({ code: 0, previews: 1 });
    expect(success.applies).toHaveLength(1);
    expect(success.applies[0]).toMatchObject({ sql, expectedRevision: 1, previewPosition: exactReceipt });
    const result = JSON.parse(success.stdout);
    expect(result).toMatchObject({ revision: 2, name: "push test", sqlHash: success.applies[0]!.sqlHash });
    expect(success.stdout.trim().split("\n")).toHaveLength(1);
    expect(await readFile(file, "utf8")).toBe(sql);
    expect(await f.pool<{ sql: string; applied_by: string; run_id: string }[]>`SELECT sql, applied_by, run_id FROM control.workspace_migrations WHERE workspace_id = ${f.workspaceId} AND revision = 2`)
      .toEqual([{ sql, applied_by: f.principalId, run_id: success.runs[0]! }]);
    expect(await f.pool<{ principal_id: string; run_id: string }[]>`SELECT principal_id, run_id FROM audit.events WHERE workspace_id = ${f.workspaceId} AND kind = 'migration.applied' AND metadata @> '{"revision":2}'::jsonb`)
      .toEqual([{ principal_id: f.principalId, run_id: success.runs[0]! }]);
    expect((await f.sql("SELECT * FROM pushed")).status).toBe(200);
  } finally { try { await f.pool.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
});
