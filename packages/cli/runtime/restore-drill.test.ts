// The drill owns a dedicated archived cluster and never restores the suite's shared database.
import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startCluster, migratedDatabase, adminUrl } from "../../../apps/server/testing/postgres.ts";
import { principalFixture } from "../../../apps/server/testing/session.ts";
import { createPool } from "../../../apps/server/platform/pool.ts";
import { restoreDrill } from "./restore-drill.ts";
import { execute } from "./execute.ts";

test("recovery entrypoints expose credentials or ignore private-file failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "bp-recovery-credential-"));
  const credential = join(root, "admin-url"), alias = join(root, "alias");
  const args = ["--data-dir", join(root, "data"), "--backup-dir", join(root, "backup"),
    "--archive-dir", join(root, "archive"), "--bin-dir", root];
  const secret = "postgres://postgres:sentinel:/secret@localhost/postgres";
  try {
    await writeFile(credential, secret, { mode: 0o600 });
    await symlink(credential, alias);
    const cli = async (env: Record<string, string>, paths = args) => {
      let stdout = "", stderr = "";
      const exit = await execute(["restore-drill", ...paths], { env, stdin: async () => "",
        stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
      expect(exit).not.toBe(0);
      expect(stdout + stderr).not.toContain("sentinel");
      return JSON.parse(stderr || stdout).error;
    };
    expect(await cli({ BP_ADMIN_DATABASE_URL: secret })).toBe("BP_BACKUP_ADMIN_URL_FILE_required");
    expect(await cli({ BP_BACKUP_ADMIN_URL_FILE: credential })).toBe("backup_credential_url_invalid");
    await writeFile(credential, "https://postgres:sentinel@localhost/postgres");
    expect(await cli({ BP_BACKUP_ADMIN_URL_FILE: credential })).toBe("backup_credential_url_invalid");
    await chmod(credential, 0o644);
    expect(await cli({ BP_BACKUP_ADMIN_URL_FILE: credential })).toBe("backup_credential_file_must_be_private_and_owned");
    await chmod(credential, 0o600);
    expect(await cli({ BP_BACKUP_ADMIN_URL_FILE: alias })).toBe("ELOOP");
    await writeFile(credential, "x".repeat(16385));
    expect(await cli({ BP_BACKUP_ADMIN_URL_FILE: credential })).toBe("backup_credential_file_must_be_private_and_owned");
    await writeFile(credential, "postgres://postgres:sentinel@localhost/postgres");
    expect(await cli({ BP_BACKUP_ADMIN_URL_FILE: credential },
      ["--data-dir", root, "--backup-dir", root, "--archive-dir", root, "--bin-dir", root])).toBe("backup_paths_overlap");
    await writeFile(credential, secret);
    for (const operation of ["backup", "restore"]) {
      const entry = new URL("../../../apps/server/restore/backup-restore.ts", import.meta.url).pathname;
      const child = Bun.spawn([process.execPath, entry, operation, join(root, "data"), join(root, "backup"), join(root, "archive"), root], {
        env: { PATH: Bun.env.PATH, BP_BACKUP_ADMIN_URL_FILE: credential }, stdout: "pipe", stderr: "pipe",
      });
      const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(exit).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr.trim()).toBe("backup_credential_url_invalid");
    }
    expect(await Bun.file(join(root, "backup/manifest.json")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

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
    const binDir = join(root, "bin"), environments = join(root, "helpers.jsonl"), credential = join(root, "admin-url");
    await mkdir(binDir);
    await writeFile(credential, adminUrl(url), { mode: 0o600 });
    await writeFile(join(binDir, "pg_ctl"), `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(environments)}, JSON.stringify(Object.keys(process.env).sort()) + "\\n");
process.exit(await Bun.spawn([${JSON.stringify(join(cluster.binDir, "pg_ctl"))}, ...Bun.argv.slice(2)], { env: process.env, stdout: "inherit", stderr: "inherit" }).exited);
`, { mode: 0o700 });
    const args = (name: string) => ["--data-dir", cluster.dataDir, "--backup-dir", join(root, name), "--archive-dir", archiveDir, "--bin-dir", binDir];
    const env = { BP_BACKUP_ADMIN_URL_FILE: credential };
    let stdout = "", stderr = "";
    expect(await execute(["restore-drill", ...args("backup")], { env, stdin: async () => "",
      stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } }), `${stdout}\n${stderr}`).toBe(0);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout) as { heads: { workspaceId: string; head: string }[]; expectedHeads: { workspaceId: string; head: string }[] };
    expect(report).toMatchObject({ success: true, headsMatch: true, gateArmed: true });
    expect(report.heads).toEqual(report.expectedHeads);
    expect(report.heads.map((h) => h.workspaceId)).toContain(f.workspaceId);
    const helpers = (await readFile(environments, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(helpers).toHaveLength(4);
    for (const helper of helpers) expect(helper).toEqual(["LANG", "PATH"]);
    const failure = await restoreDrill(args("broken-backup"), env, async (manifest) => {
      await rm(join(archiveDir, manifest.segment));
    });
    expect(failure).toMatchObject({ success: false });
    // Hot standby may briefly become ready before recovery discovers missing WAL.
    // The failure can therefore arrive from pg_ctl or the subsequent connection.
    expect(["pg_ctl_failed", "restore_drill_failed"]).toContain("error" in failure ? failure.error : "");
    expect(await pool<{ active: boolean }[]>`SELECT active FROM control.restore_gate`).toEqual([{ active: false }]);
    expect(stdout + JSON.stringify(failure)).not.toContain(adminUrl(url));
  } finally {
    try { await pool?.close(); } finally {
      try { await source?.stop(); } finally { await rm(root, { recursive: true, force: true }); }
    }
    const seconds = (performance.now() - started) / 1000;
    console.log(`CLI restore drill: ${seconds.toFixed(3)}s`); expect(seconds).toBeLessThan(120);
  }
}, 120_000);
