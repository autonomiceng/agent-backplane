// Apply and User rebuild share one request-driven, ledger-only projection resource.
import { lstat, mkdir, open, mkdtemp, rename, rm } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import type { ProjectionResponse } from "./rebuild-migration-projection-input.ts";
import type { MigrationEntry } from "./list-migrations-input.ts";
import { listMigrations } from "./list-migrations.ts";
export type ProjectionResult = { ok: true; response: ProjectionResponse } | { ok: false; status: 403 | 409 | 503; error: string };
export type MigrationProjection = { project(context: RunContext): Promise<ProjectionResult> };
async function directory(path: string): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split("/")) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(current)).isDirectory()) throw new Error("unsafe_projection_path");
  }
}
async function atomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export function createMigrationProjection(pool: Pool, dataDir: string, logger: Pick<Console, "error">, executable: string | null): MigrationProjection {
  const active = new Map<string, { dirty: boolean; context: RunContext; pending: ((result: ProjectionResult) => void)[] }>();
  const snapshot = async (context: RunContext): Promise<ProjectionResult> => {
    const workspaceId = context.workspaceId.toLowerCase();
    let revision = 0, stage = "snapshot";
    const failed = (status: 409 | 503, error: string): ProjectionResult => {
      logger.error({ ...context, revision, stage, error });
      return { ok: false, status, error };
    };
    let staging: string | undefined;
    try {
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(workspaceId)) throw new Error("invalid_workspace");
      let page = await listMigrations(pool, workspaceId, { limit: 100 });
      revision = page.currentRevision;
      const entries: (Omit<MigrationEntry, "sql"> & { filename: string })[] = [];
      const parent = resolve(dataDir, "projections"), root = join(parent, workspaceId);
      stage = "files";
      await directory(parent);
      const owner = await lstat(parent);
      if (owner.uid !== process.getuid?.() || (owner.mode & 0o777) !== 0o700) throw new Error("unsafe_projection_owner");
      staging = await mkdtemp(join(parent, `.${workspaceId}-`));
      const migrations = join(staging, "migrations");
      await mkdir(migrations, { mode: 0o700 });
      while (true) {
        for (const row of page.migrations) {
          const slug = row.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80).replace(/^-|-$/g, "") || "migration";
          const filename = `${String(row.revision).padStart(4, "0")}-${slug}.sql`;
          await atomic(join(migrations, filename), row.sql);
          const { sql: _sql, ...metadata } = row;
          entries.push({ ...metadata, filename });
        }
        if (page.nextAfterRevision === null) break;
        page = await listMigrations(pool, workspaceId, { limit: 100, afterRevision: page.nextAfterRevision }, revision);
      }
      await atomic(join(staging, "manifest.json"), `${JSON.stringify({ workspaceId, revision, migrations: entries }, null, 2)}\n`);
      const previous = `${staging}.old`;
      const existing = await lstat(root).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing) await rename(root, previous);
      let movedGit = false;
      try {
        if (existing?.isDirectory() && (await lstat(join(previous, ".git")).catch(() => undefined))?.isDirectory()) {
          await rename(join(previous, ".git"), join(staging, ".git")); movedGit = true;
        }
        await rename(staging, root);
      } catch (error) {
        if (movedGit) await rename(join(staging, ".git"), join(previous, ".git"));
        if (existing) await rename(previous, root);
        throw error;
      }
      if (existing) await rm(previous, { recursive: true, force: true });
      stage = "git";
      if (!executable) return { ok: true, response: { workspaceId, revision, mode: "directory", commit: null } };
      await directory(join(root, ".git"));
      const git = async (args: string[], capture = false, diff = false) => {
        const child = Bun.spawn([executable, "--git-dir", join(root, ".git"), "--work-tree", root,
          "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false",
          "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "core.autocrlf=false", ...args], {
          cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Backplane", GIT_AUTHOR_EMAIL: "backplane@localhost",
            GIT_COMMITTER_NAME: "Backplane", GIT_COMMITTER_EMAIL: "backplane@localhost" }, stdout: "pipe", stderr: "ignore",
        });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
        try {
          let output = "", bytes = 0;
          for await (const chunk of child.stdout) {
            if (capture) {
              if ((bytes += chunk.byteLength) > 128) { child.kill("SIGKILL"); throw new Error("git_output_limit"); }
              output += new TextDecoder().decode(chunk);
            }
          }
          const code = await child.exited;
          if (code !== 0 && !(diff && code === 1)) throw new Error("git_failed");
          return { output: output.trim(), changed: code === 1 };
        } finally { clearTimeout(timeout); await child.exited; }
      };
      await git(["init", "--quiet", "--template=", "--initial-branch=main"]);
      await git(["add", "--all", "--", "."]);
      if ((await git(["diff", "--cached", "--quiet"], false, true)).changed) await git(["commit", "--quiet", "-m", `Project migrations through revision ${revision}`]);
      const { output: commit } = await git(["rev-parse", "HEAD"], true);
      return { ok: true, response: { workspaceId, revision, mode: "git", commit } };
    } catch { return failed(503, "projection_unavailable"); }
    finally { if (staging) await rm(staging, { recursive: true, force: true }); }
  };
  return { project(context) {
    const workspaceId = context.workspaceId.toLowerCase(), queued = active.get(workspaceId);
    return new Promise<ProjectionResult>((resolve) => {
      if (queued) { queued.dirty = true; queued.context = context; queued.pending.push(resolve); return; }
      const state = { dirty: true, context, pending: [resolve] };
      active.set(workspaceId, state);
      void (async () => {
        try {
          while (state.dirty) {
            state.dirty = false;
            const pending = state.pending.splice(0);
            const result = await snapshot(state.context).catch(() => ({ ok: false, status: 503, error: "projection_unavailable" } satisfies ProjectionResult));
            for (const done of pending) done(result);
          }
        } finally { active.delete(workspaceId); }
      })();
    });
  } };
}
