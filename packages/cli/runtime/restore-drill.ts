// The CLI backs up the source and verifies recovery only inside an owned temporary directory.
import { SQL } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { backup, restore } from "../../../apps/server/restore/backup-restore.ts";
import { CliError, type Environment } from "./credentials.ts";
export const restoreDrillHelp = "bp restore-drill --data-dir PATH --backup-dir NEW --archive-dir PATH --bin-dir PATH (BP_ADMIN_DATABASE_URL required)";
type Head = { workspaceId: string; head: string };
type Verification = { heads: Head[]; gateArmed: boolean };
export type RestoreDrillReport = { success: boolean; headsMatch: boolean; gateArmed: boolean; epoch: string;
  heads: Head[]; expectedHeads: Head[]; elapsedMs: number } | { success: false; error: string; elapsedMs: number };

// Administrative inspection is confined to the recovered cluster's private socket.
async function verifyRecovery(dataDir: string, socket: string, binDir: string, adminUrl: string, epoch: string): Promise<Verification> {
  await mkdir(socket, { mode: 0o700 });
  const connection = new URL(adminUrl);
  const ctl = async (...args: string[]) => {
    const child = Bun.spawn([join(binDir, "pg_ctl"), "-D", dataDir, "-w", "-t", "20", ...args], { stdout: "pipe", stderr: "pipe" });
    const [code] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code) throw new Error("drill_postgres_failed");
  };
  let sql: SQL | undefined;
  try {
    await ctl("-l", join(dataDir, "drill.log"), "-o", `-k ${socket} -p 5432 -c listen_addresses='' -c archive_mode=off`, "start");
    sql = new SQL({ path: join(socket, ".s.PGSQL.5432"), database: decodeURIComponent(connection.pathname.slice(1)),
      username: decodeURIComponent(connection.username), password: decodeURIComponent(connection.password), max: 1 });
    const heads = await sql<Head[]>`SELECT workspace_id::text AS "workspaceId",last_position::text AS head FROM audit.cursor ORDER BY workspace_id`;
    const [gate] = await sql<{ epoch: string; active: boolean }[]>`SELECT epoch::text,active FROM control.restore_gate WHERE singleton`;
    return { heads: [...heads], gateArmed: gate?.active === true && gate.epoch === epoch };
  } finally {
    await sql?.close();
    await ctl("-m", "fast", "stop").catch(() => ctl("-m", "immediate", "stop"));
  }
}
export async function restoreDrill(argv: string[], env: Environment, afterBackup?: (manifest: Awaited<ReturnType<typeof backup>>) => Promise<void>): Promise<RestoreDrillReport> {
  let values;
  try { values = parseArgs({ args: argv, options: Object.fromEntries(["data-dir", "backup-dir", "archive-dir", "bin-dir"].map((key) => [key, { type: "string" }])), strict: true, allowPositionals: false }).values; }
  catch { throw new CliError("invalid_arguments"); }
  const dataDir = values["data-dir"], backupDir = values["backup-dir"], archiveDir = values["archive-dir"], binDir = values["bin-dir"];
  if (typeof dataDir !== "string" || typeof backupDir !== "string" || typeof archiveDir !== "string" || typeof binDir !== "string") throw new CliError("restore_drill_paths_required");
  const adminUrl = env.BP_ADMIN_DATABASE_URL;
  if (!adminUrl) throw new CliError("BP_ADMIN_DATABASE_URL_required");
  const scratch = await mkdtemp(join(tmpdir(), "bp-cli-drill-")), started = performance.now();
  try {
    const options = { adminUrl, dataDir, backupDir, archiveDir, binDir };
    const manifest = await backup(options);
    await afterBackup?.(manifest);
    const recovered = await restore({ ...options, dataDir: join(scratch, "data") });
    const verified = await verifyRecovery(join(scratch, "data"), join(scratch, "socket"), binDir, adminUrl, recovered.epoch);
    // Compare per Workspace: JSON key order differs between the manifest and the recovered query.
    const byWorkspace = (heads: Head[]) => new Map(heads.map((h) => [h.workspaceId, h.head]));
    const expected = byWorkspace(manifest.after.heads), actual = byWorkspace(verified.heads);
    const headsMatch = expected.size === actual.size && [...expected].every(([workspaceId, head]) => actual.get(workspaceId) === head);
    const success = headsMatch && verified.gateArmed;
    return { success, headsMatch, gateArmed: verified.gateArmed, epoch: recovered.epoch, heads: verified.heads,
      expectedHeads: manifest.after.heads, elapsedMs: Math.round(performance.now() - started) };
  } catch { return { success: false, error: "restore_drill_failed", elapsedMs: Math.round(performance.now() - started) }; }
  finally { await rm(scratch, { recursive: true, force: true }); }
}
