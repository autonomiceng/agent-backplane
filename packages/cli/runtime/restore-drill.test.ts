// The drill owns a dedicated archived cluster and never restores the suite's shared database.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startCluster, migratedDatabase, adminUrl } from "../../../apps/server/testing/postgres.ts";
import { principalFixture } from "../../../apps/server/testing/session.ts";
import { createPool } from "../../../apps/server/platform/pool.ts";
import { restoreDrill } from "./restore-drill.ts";
import { execute } from "./execute.ts";

test("CLI restore drill accepts missing WAL or fails to verify heads and the armed gate", async () => {
  const started = performance.now(), root = await mkdtemp(join(tmpdir(), "bp-cli-restore-test-"));
  let source: Awaited<ReturnType<typeof startCluster>> | undefined;
  let pool: ReturnType<typeof createPool> | undefined;
  try {
    const archiveDir = join(root, "archive"); await mkdir(archiveDir);
    const script = new URL("../../../infra/backup/archive.sh", import.meta.url).pathname;
    source = await startCluster(["archive_mode=on", `archive_command='"${script}" "%p" "%f" "${archiveDir}"'`]);
    const url = await migratedDatabase(source.url);
    pool = createPool(url);
    const cluster = source;
    const f = await principalFixture(pool);
    const args = (name: string) => ["--data-dir", cluster.dataDir, "--backup-dir", join(root, name), "--archive-dir", archiveDir, "--bin-dir", cluster.binDir];
    const env = { BP_ADMIN_DATABASE_URL: adminUrl(url) };
    let stdout = "", stderr = "";
    expect(await execute(["restore-drill", ...args("backup")], { env, stdin: async () => "",
      stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } }), `${stdout}\n${stderr}`).toBe(0);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout) as { heads: { workspaceId: string; head: string }[]; expectedHeads: { workspaceId: string; head: string }[] };
    expect(report).toMatchObject({ success: true, headsMatch: true, gateArmed: true });
    expect(report.heads).toEqual(report.expectedHeads);
    expect(report.heads.map((h) => h.workspaceId)).toContain(f.workspaceId);
    const failure = await restoreDrill(args("broken-backup"), env, async (manifest) => {
      await rm(join(archiveDir, manifest.segment));
    });
    expect(failure).toMatchObject({ success: false, error: "restore_drill_failed" });
    expect(await pool<{ active: boolean }[]>`SELECT active FROM control.restore_gate`).toEqual([{ active: false }]);
    expect(stdout + JSON.stringify(failure)).not.toContain(env.BP_ADMIN_DATABASE_URL);
  } finally {
    try { await pool?.close(); } finally {
      try { await source?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
    }
    const seconds = (performance.now() - started) / 1000;
    console.log(`CLI restore drill: ${seconds.toFixed(3)}s`); expect(seconds).toBeLessThan(120);
  }
}, 120_000);
