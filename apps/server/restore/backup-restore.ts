// Operator-only physical recovery; shell wrappers and the dedicated cluster drill share these phases.
// Direct SQL clients are an exception here: recovery runs before and outside the application pool.
// The repository must be encrypted and replicated off-host by the operator, including continuous WAL.
import { SQL } from "bun";
import { constants } from "node:fs";
import { cp, open, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, relative, sep } from "node:path";
import { tmpdir } from "node:os";
type Options = { adminUrl: string; dataDir: string; backupDir: string; archiveDir: string; binDir: string };
type Snapshot = { systemId: string; timeline: number; postgres: string; schema: number; pgmq: string;
  heads: { workspaceId: string; head: string }[] };
// Recovery helpers need no inherited database or provider credentials.
export const helperEnv = { PATH: Bun.env.PATH ?? "/usr/bin:/bin", LANG: "C" };
function credentialUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username) throw new Error();
    for (const part of [url.username, url.password, url.pathname]) decodeURIComponent(part);
    return url;
  } catch { throw new Error("backup_credential_url_invalid"); }
}
// Only the locator crosses argv/environment; checks stay bound to the open descriptor.
export async function loadBackupAdminUrl(path: string | undefined): Promise<string> {
  if (!path) throw new Error("BP_BACKUP_ADMIN_URL_FILE_required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16384) {
      throw new Error("backup_credential_file_must_be_private_and_owned");
    }
    const value = (await file.readFile("utf8")).trim();
    credentialUrl(value);
    return value;
  } finally { await file.close(); }
}
// Recovery boundaries emit known diagnostics, never driver messages or helper output.
export function recoveryErrorCode(error: unknown, fallback = "backup_restore_failed"): string {
  if (error instanceof Error && ["BP_BACKUP_ADMIN_URL_FILE_required", "backup_credential_url_invalid",
    "backup_credential_file_must_be_private_and_owned", "backup_restore_usage", "backup_paths_overlap",
    "unsupported_backup_source", "backup_snapshot_failed", "backup_source_changed", "backup_sync_failed",
    "recovery_deadline_exceeded", "pg_ctl_failed", "restore_identity_mismatch", "restore_head_missing",
    "restore_target_missing", "drill_postgres_failed"].includes(error.message)) return error.message;
  if (error instanceof Error && "code" in error && typeof error.code === "string"
    && /^(?:E[A-Z]+|ERR_[A-Z_]+|[0-9A-Z]{5})$/.test(error.code)) return error.code;
  return fallback;
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const setting = (s: string) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const entry = await lstat(path).catch(() => null);
    if (entry) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}
async function separatedPaths(options: Options) {
  const dataDir = await canonicalPath(resolve(options.dataDir));
  const backupDir = await canonicalPath(resolve(options.backupDir));
  const archiveDir = await canonicalPath(resolve(options.archiveDir));
  const paths = [dataDir, backupDir, archiveDir];
  for (const parent of paths) for (const child of paths.filter((path) => path !== parent)) {
    const distance = relative(parent, child);
    if (distance !== ".." && !distance.startsWith(`..${sep}`)) throw new Error("backup_paths_overlap");
  }
  if (new Set(paths).size !== 3) throw new Error("backup_paths_overlap");
  return { ...options, dataDir, backupDir, archiveDir };
}
async function snapshot(sql: SQL): Promise<Snapshot> {
  const [row] = await sql<Snapshot[]>`SELECT (pg_control_system()).system_identifier::text AS "systemId",
    (pg_control_checkpoint()).timeline_id AS timeline,current_setting('server_version_num') AS postgres,
    (SELECT max(version)::int FROM control.schema_version) AS schema,(SELECT version FROM pgmq.backplane_install LIMIT 1) AS pgmq,
    (SELECT jsonb_agg(jsonb_build_object('workspaceId',workspace_id,'head',last_position::text) ORDER BY workspace_id)
      FROM audit.cursor) AS heads`;
  if (!row) throw new Error("backup_snapshot_failed");
  return { ...row, heads: typeof row.heads === "string" ? JSON.parse(row.heads) : row.heads ?? [] };
}
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 25_000;
  while (!await check()) {
    if (Date.now() >= until) throw new Error("recovery_deadline_exceeded");
    await Bun.sleep(100);
  }
}
export async function backup(options: Options, afterCopy?: () => Promise<void>, afterSnapshot?: () => Promise<void>) {
  credentialUrl(options.adminUrl);
  const { adminUrl, dataDir, backupDir, archiveDir } = await separatedPaths(options);
  const sql = new SQL({ url: adminUrl, max: 1 });
  const name = `bp_${crypto.randomUUID().replaceAll("-", "")}`;
  let started = false;
  try {
    const [source] = await sql`SELECT current_setting('data_directory') AS directory,
      current_setting('config_file') AS config, current_setting('hba_file') AS hba, current_setting('ident_file') AS ident,
      (SELECT count(*)::int FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')) AS tablespaces`;
    if (await realpath(source.directory) !== dataDir || source.tablespaces) throw new Error("unsupported_backup_source");
    for (const [path, name] of [[source.config, "postgresql.conf"], [source.hba, "pg_hba.conf"], [source.ident, "pg_ident.conf"]]) {
      if (await realpath(path) !== join(dataDir, name)) throw new Error("unsupported_backup_source");
    }
    const before = await snapshot(sql);
    await mkdir(backupDir, { mode: 0o700 });
    await sql`SELECT pg_backup_start(${name},true)`; started = true;
    await cp(dataDir, join(backupDir, "data"), { recursive: true, dereference: true, filter: (path) =>
      !["pg_wal", "postmaster.pid", "postmaster.opts", "log"].includes(relative(dataDir, path).split("/")[0] ?? "")
      && !relative(dataDir, path).startsWith(`pg_replslot${sep}`) });
    await afterCopy?.();
    const [stop] = await sql`SELECT * FROM pg_backup_stop(false)`; started = false;
    await writeFile(join(backupDir, "data/backup_label"), stop.labelfile);
    if (stop.spcmapfile) await writeFile(join(backupDir, "data/tablespace_map"), stop.spcmapfile);
    const after = await snapshot(sql);
    if (before.systemId !== after.systemId || before.timeline !== after.timeline || before.schema !== after.schema
      || before.postgres !== after.postgres || before.pgmq !== after.pgmq) throw new Error("backup_source_changed");
    await afterSnapshot?.();
    const [point] = await sql`SELECT pg_create_restore_point(${name})::text AS lsn`;
    const [wal] = await sql`SELECT pg_walfile_name(${point.lsn}::pg_lsn) AS segment`;
    await sql`SELECT pg_switch_wal()`;
    await waitFor(() => Bun.file(join(archiveDir, wal.segment)).exists());
    const manifest = { name, before, after, targetLsn: String(point.lsn), segment: String(wal.segment) };
    if (await Bun.spawn(["sync", "-f", backupDir], { env: helperEnv }).exited) throw new Error("backup_sync_failed");
    const temporary = join(backupDir, ".manifest.json.tmp");
    const file = await open(temporary, "wx", 0o600);
    try {
      try { await file.writeFile(JSON.stringify(manifest)); await file.sync(); }
      catch (error) { await file.close().catch(() => {}); throw error; }
      await file.close();
      await rename(temporary, join(backupDir, "manifest.json"));
    } catch (error) {
      // Only remove the temporary file created by this invocation; preserve its error.
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    const directory = await open(backupDir, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
    return manifest;
  } finally {
    if (started) await sql`SELECT pg_backup_stop(false)`.catch(() => {});
    await sql.close();
  }
}
export async function restore(options: Options): Promise<{ epoch: string; active: boolean }> {
  const admin = credentialUrl(options.adminUrl);
  const { dataDir, backupDir, archiveDir, binDir } = await separatedPaths(options);
  const manifest: Awaited<ReturnType<typeof backup>> = await Bun.file(join(backupDir, "manifest.json")).json();
  await mkdir(dataDir, { mode: 0o700 });
  const socket = await mkdtemp(join(tmpdir(), "bp-recovery-"));
  // The client is created only after the recovered server listens: Bun's client fails permanently on a missing socket.
  let sql: SQL | undefined;
  const connect = () => sql ??= new SQL({ username: decodeURIComponent(admin.username), database: decodeURIComponent(admin.pathname.slice(1)),
    path: join(socket, ".s.PGSQL.5432"), max: 1, connectionTimeout: 5 });
  const ctl = async (...args: string[]) => {
    const child = Bun.spawn([join(binDir, "pg_ctl"), "-D", dataDir, "-w", "-t", "25", ...args], { stdout: "pipe", stderr: "pipe", env: helperEnv });
    const [code] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code) throw new Error("pg_ctl_failed");
  };
  let launched = false;
  try {
    await cp(join(backupDir, "data"), dataDir, { recursive: true, dereference: true });
    await mkdir(join(dataDir, "pg_wal"), { recursive: true });
    const auto = await readFile(join(dataDir, "postgresql.auto.conf"), "utf8")
      + `\ndata_directory=${setting(resolve(dataDir))}\nhba_file=${setting(join(dataDir, "pg_hba.conf"))}\nident_file=${setting(join(dataDir, "pg_ident.conf"))}\nexternal_pid_file=''\n`;
    const hba = join(dataDir, "restore-hba.conf");
    await writeFile(hba, `local all ${'"' + decodeURIComponent(admin.username).replaceAll('"', '""') + '"'} trust\nlocal all all reject\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n`);
    await writeFile(join(dataDir, "postgresql.auto.conf"), `${auto}\nlisten_addresses=''\nport=5432\nunix_socket_directories=${setting(socket)}\nhba_file=${setting(hba)}\narchive_mode=off\nlogging_collector=off\nrestore_command=${setting(`cp ${quote(resolve(archiveDir))}/%f %p`)}\nrecovery_target_name=${setting(manifest.name)}\nrecovery_target_timeline=${setting(String(manifest.after.timeline))}\nrecovery_target_action='promote'\n`);
    await writeFile(join(dataDir, "recovery.signal"), "");
    launched = true;
    await ctl("-l", join(dataDir, "restore.log"), "start");
    const sql = connect();
    await waitFor(async () => !(await sql`SELECT pg_is_in_recovery() AS recovering`)[0].recovering);
    const restored = await snapshot(sql);
    if (restored.systemId !== manifest.after.systemId || restored.timeline <= manifest.after.timeline || restored.postgres !== manifest.after.postgres
      || restored.schema !== manifest.after.schema || restored.pgmq !== manifest.after.pgmq) throw new Error("restore_identity_mismatch");
    for (const expected of manifest.after.heads) {
      const actual = restored.heads.find((h) => h.workspaceId === expected.workspaceId);
      if (!actual || BigInt(actual.head) < BigInt(expected.head)) throw new Error("restore_head_missing");
    }
    const [target] = await sql`SELECT pg_last_wal_replay_lsn()>=${manifest.targetLsn}::pg_lsn AS reached`;
    if (!target.reached) throw new Error("restore_target_missing");
    const epoch = crypto.randomUUID();
    const active = restored.heads.length > 0;
    await sql.begin(async (tx) => {
      await tx`UPDATE control.restore_gate SET epoch=${epoch},active=${active},backup_id=${manifest.name},target_lsn=${manifest.targetLsn} WHERE singleton`;
      for (const head of restored.heads) await tx`INSERT INTO control.restore_workspaces(epoch,workspace_id,minimum_head)
        VALUES(${epoch},${head.workspaceId},${manifest.after.heads.find((required) => required.workspaceId === head.workspaceId)?.head ?? "0"})`;
    });
    await sql.close();
    await ctl("-m", "fast", "stop"); launched = false;
    const temporary = join(dataDir, ".postgresql.auto.conf.restore.tmp");
    const config = await open(temporary, "wx", 0o600);
    try {
      try { await config.writeFile(auto); await config.sync(); }
      catch (error) { await config.close().catch(() => {}); throw error; }
      await config.close();
      await rename(temporary, join(dataDir, "postgresql.auto.conf"));
    } catch (error) { await rm(temporary, { force: true }).catch(() => {}); throw error; }
    const directory = await open(dataDir, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
    return { epoch, active };
  } finally {
    await sql?.close();
    if (launched) await ctl("-m", "immediate", "stop").catch(() => {});
    await rm(socket, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  try {
    const [command, dataDir, backupDir, archiveDir, binDir] = Bun.argv.slice(2);
    if ((command !== "backup" && command !== "restore") || !dataDir || !backupDir || !archiveDir || !binDir) {
      throw new Error("backup_restore_usage");
    }
    const adminUrl = await loadBackupAdminUrl(Bun.env.BP_BACKUP_ADMIN_URL_FILE);
    const options = { adminUrl, dataDir: resolve(dataDir), backupDir: resolve(backupDir), archiveDir: resolve(archiveDir), binDir: resolve(binDir) };
    console.log(JSON.stringify(await (command === "backup" ? backup(options) : restore(options))));
  } catch (error) {
    console.error(recoveryErrorCode(error));
    process.exitCode = 1;
  }
}
