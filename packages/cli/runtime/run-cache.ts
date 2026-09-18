// Per-entry filesystem locks serialize lazy Run creation and conditional replacement across CLI processes.
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { CliError, type Credentials } from "./credentials.ts";
import { safeDirectory } from "./secure-directory.ts";
import { record } from "./http.ts";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
type Entry = { version: number; identity: string; fingerprint: string; id: string; principalId: string; workspaceId: string; lastUsedAt: number };
export function runCache(config: Credentials, now: () => number) {
  const identity = digest(JSON.stringify([config.url, config.workspaceId, config.key.split("_")[1], config.session]));
  const fingerprint = digest(config.key), path = join(config.directory, `${identity}.json`), lock = `${path}.lock`;
  const valid = (v: unknown): v is Entry => record(v) && v.version === 1 && v.identity === identity && v.fingerprint === fingerprint
    && uuid(v.id) && uuid(v.principalId) && v.workspaceId === config.workspaceId && typeof v.lastUsedAt === "number"
    && v.lastUsedAt <= now() && now() - v.lastUsedAt < 24 * 60 * 60 * 1000;
  const read = async () => {
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) { if (record(e) && e.code === "ENOENT") return; throw new CliError("unsafe_cache_file"); }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new CliError("unsafe_cache_file");
      let value: unknown;
      try { value = JSON.parse(await file.readFile("utf8")); } catch { return; }
      return valid(value) ? value : undefined;
    } finally { await file.close(); }
  };
  const write = async (entry: Entry) => {
    const temporary = `${path}.${randomUUID()}`;
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(entry)); await file.sync(); }
    finally { await file.close(); }
    try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
  };
  const locked = async <T>(fn: () => Promise<T>) => {
    await safeDirectory(dirname(config.directory));
    await safeDirectory(config.directory);
    const deadline = performance.now() + 10_000;
    while (true) {
      if (performance.now() >= deadline) throw new CliError("run_cache_locked");
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (e) { if (!record(e) || e.code !== "EEXIST") throw e; }
      try {
        const stat = await lstat(lock);
        if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new CliError("unsafe_cache_lock");
        let owner: unknown;
        try { owner = JSON.parse(await readFile(join(lock, "owner"), "utf8")); }
        catch (e) { if (!(e instanceof SyntaxError) && (!record(e) || e.code !== "ENOENT")) throw e; }
        let stale = Date.now() - stat.mtimeMs > 60_000;
        if (record(owner) && typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0
          && typeof owner.createdAt === "number" && Number.isFinite(owner.createdAt)) {
          stale = Date.now() - owner.createdAt > 60_000;
          try { process.kill(owner.pid, 0); }
          catch (e) { if (record(e) && e.code === "ESRCH") stale = true; }
        }
        if (stale) {
          const current = await lstat(lock);
          if (current.ino !== stat.ino || current.dev !== stat.dev) continue;
          const abandoned = `${lock}.${randomUUID()}`;
          await rename(lock, abandoned);
          await rm(abandoned, { recursive: true });
          continue;
        }
      } catch (e) { if (record(e) && e.code === "ENOENT") continue; throw e; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const acquired = await lstat(lock);
    try {
      await writeFile(join(lock, "owner"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { mode: 0o600, flag: "wx" });
      return await fn();
    } finally {
      // A lock older than 60 seconds may have been replaced while its original owner was still running.
      const current = await lstat(lock).catch((e: unknown) => {
        if (record(e) && e.code === "ENOENT") return undefined;
        throw e;
      });
      if (current?.ino === acquired.ino && current.dev === acquired.dev) await rm(lock, { recursive: true, force: true });
    }
  };
  return {
    select(create: () => Promise<unknown>, rejected?: string, force = false) {
      return locked(async () => {
        const entry = await read();
        if (!force && entry && entry.id !== rejected) return entry.id;
        const value = await create();
        if (!record(value) || !uuid(value.id) || !uuid(value.principalId) || value.workspaceId !== config.workspaceId) throw new CliError("invalid_run_response", 1);
        await write({ version: 1, identity, fingerprint, id: value.id, principalId: value.principalId, workspaceId: config.workspaceId, lastUsedAt: now() });
        return value.id;
      });
    },
    touch(id: string) {
      return locked(async () => { const entry = await read(); if (entry?.id === id) await write({ ...entry, lastUsedAt: now() }); });
    },
  };
}
