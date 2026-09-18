// CLI session and Run storage share directory ownership and symlink checks.
import { chmod, lstat, mkdir } from "node:fs/promises";
import { join, parse, resolve } from "node:path";
import { CliError } from "./credentials.ts";
import { record } from "./http.ts";
type DirectoryEntry = { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number };
export function assertSecureDirectory(entry: DirectoryEntry, owner?: number): void {
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new CliError("unsafe_cache_directory");
  if (owner !== undefined && entry.uid !== owner) throw new CliError("unsafe_cache_owner");
}
export async function safeDirectory(directory: string): Promise<void> {
  const path = resolve(directory), root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split("/")) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (e) { if (!record(e) || e.code !== "EEXIST") throw e; }
    const stat = await lstat(current);
    assertSecureDirectory(stat);
  }
  const stat = await lstat(path);
  assertSecureDirectory(stat, process.getuid?.());
  await chmod(path, 0o700);
}
