import EmbeddedPostgres from "embedded-postgres";
import { existsSync, rmSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SQL } from "bun";
import { loadMigrations, migrate } from "../../../db/migrations.ts";
import { sqlMigrationRunner } from "../../../db/sql-migration-runner.ts";

// A throwaway PostgreSQL 18 cluster for integration tests. One cluster per test run, one database per caller.
// Started by testing/preload.ts, which publishes the superuser url in BP_TEST_POSTGRES_URL.

const INIT_DIR = new URL("../../../infra/init/core", import.meta.url).pathname;
const MIGRATIONS_DIR = new URL("../../../db/migrations", import.meta.url).pathname;
const START_ATTEMPTS = 5;
const runtimeLogins = new Map<string, Promise<void>>();

export type TestCluster = { url: string; dataDir: string; binDir: string; restart(): Promise<void>; stop(): Promise<void> };

// Retries on a busy port; keeps the last attempt's diagnostics so a failure explains itself.
export async function startCluster(settings: string[] = []): Promise<TestCluster> {
  const binDir = join(dirname(Bun.resolveSync(`@embedded-postgres/${process.platform}-${process.arch}`,
    dirname(Bun.resolveSync("embedded-postgres", import.meta.dir)))), "../native/bin");
  let lastError: unknown;
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    const databaseDir = await mkdtemp(join(tmpdir(), "bp-pg-"));
    // Exit hooks cannot await cleanup. A crash (including SIGKILL) may leave this directory behind.
    const cleanup = () => {
      if (existsSync(join(databaseDir, "postmaster.pid"))) {
        const stopped = Bun.spawnSync([join(binDir, "pg_ctl"), "-D", databaseDir, "-w", "-m", "fast", "stop"], { stdout: "pipe", stderr: "pipe" });
        if (stopped.exitCode !== 0) {
          console.error(`embedded postgres cleanup failed: ${databaseDir}\n${stopped.stderr.toString()}`);
          process.exitCode = 1;
          return;
        }
      }
      rmSync(databaseDir, { recursive: true, force: true });
    };
    // Cleanup must precede the preload's process-level leak assertion.
    process.prependListener("exit", cleanup);
    const port = 20000 + Math.floor(Math.random() * 20000);
    const diagnostics: string[] = [];
    const pg = new EmbeddedPostgres({
      databaseDir,
      port,
      user: "postgres",
      password: "postgres",
      // This fixture owns deletion in stop/exit; library stop must permit a restart.
      persistent: true,
      onLog: (m) => diagnostics.push(String(m)),
      onError: (m) => diagnostics.push(String(m)),
    });
    try {
      await pg.initialise();
      await appendFile(join(databaseDir, "postgresql.conf"), "\n" + settings.join("\n") + "\n");
      await pg.start();
      // Startup returns before the listener accepts every connection under load; wait until a query succeeds.
      const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
      for (let waited = 0; ; waited += 250) {
        try { const probe = new SQL({ url, max: 1 }); await probe`SELECT 1`; await probe.close(); break; }
        catch (error) { if (waited >= 15_000) throw error; await Bun.sleep(250); }
      }
      return {
        dataDir: databaseDir,
        binDir,
        url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
        async restart() { await pg.stop(); await pg.start(); },
        async stop() {
          try { await pg.stop(); } finally {
            await rm(databaseDir, { recursive: true, force: true });
            process.off("exit", cleanup);
          }
        },
      };
    } catch (error) {
      lastError = new Error(`embedded postgres failed on port ${port}: ${String(error)}\n${diagnostics.join("\n")}`);
      await pg.stop().catch(() => {});
      await rm(databaseDir, { recursive: true, force: true });
      process.off("exit", cleanup);
    }
  }
  throw lastError;
}

function clusterUrl(): string {
  const url = Bun.env.BP_TEST_POSTGRES_URL;
  if (!url) throw new Error("integration tests need BP_TEST_POSTGRES_URL; run bun run test");
  return url;
}

async function withSql<T>(url: string, fn: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL({ url, max: 1 });
  try {
    return await fn(sql);
  } finally {
    await sql.close();
  }
}

// A new empty database on the shared cluster. Nothing installed: no pgmq, no protected schemas.
export async function emptyDatabase(sourceUrl = clusterUrl()): Promise<string> {
  const name = `t_${crypto.randomUUID().replaceAll("-", "")}`;
  await withSql(sourceUrl, (admin) => admin.unsafe(`CREATE DATABASE ${name}`));
  return new URL(`/${name}`, sourceUrl).toString();
}

// A database with the compose init scripts run (pgmq and its version stamp) and every repository migration applied.
export async function migratedDatabase(sourceUrl = clusterUrl(), throughVersion = Infinity): Promise<string> {
  const url = await emptyDatabase(sourceUrl);
  await withSql(url, async (sql) => {
    for (const file of ["001-pgmq.sql", "002-pgmq-version.sql"]) {
      await sql.unsafe(await Bun.file(join(INIT_DIR, file)).text());
    }
    await migrate(sqlMigrationRunner(sql), (await loadMigrations(MIGRATIONS_DIR)).filter(m => m.version <= throughVersion));
    const cluster = sourceUrl;
    let login = runtimeLogins.get(cluster);
    if (!login) {
      login = withSql(cluster, async (admin) => {
        await admin`ALTER ROLE bp_server LOGIN PASSWORD 'bp_server'`;
      }).catch((error) => {
        runtimeLogins.delete(cluster);
        throw error;
      });
      runtimeLogins.set(cluster, login);
    }
    await login;
  });
  const runtime = new URL(url);
  runtime.username = "bp_server";
  runtime.password = "bp_server";
  return runtime.toString();
}

// Tests that inspect protected state or administer a migrated database explicitly opt into the owner.
export function adminUrl(url: string): string {
  const admin = new URL(url);
  admin.username = "postgres";
  admin.password = "postgres";
  return admin.toString();
}

export async function latestMigrationVersion(): Promise<number> {
  return (await loadMigrations(MIGRATIONS_DIR)).at(-1)?.version ?? 0;
}
