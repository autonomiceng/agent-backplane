// CLI bootstrap, private issuance output and MCP share strict local credential custody.
import { constants } from "node:fs";
import { open, rename, rm, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { CliError, credentials, type Environment } from "./credentials.ts";
import { record } from "./http.ts";
export type CredentialFile = { url: string; workspaceId: string; principalId: string; key: string };
export const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
export function canonicalUuid(value: unknown): string {
  if (typeof value !== "string" || !uuid(value.toLowerCase())) throw new CliError("invalid_uuid", 1);
  return value.toLowerCase();
}
async function privateParent(path: string) {
  const parent = resolve(dirname(path));
  if (await realpath(parent) !== parent) throw new CliError("unsafe_private_directory", 1);
  const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = await directory.stat(), rootSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || !rootSticky && (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)) throw new CliError("unsafe_private_directory", 1);
    // Node has no openat; Linux procfs keeps child operations bound to the checked directory descriptor.
    return { directory, path: process.platform === "linux" ? `/proc/self/fd/${directory.fd}/${basename(path)}` : resolve(path) };
  } catch (e) { await directory.close(); throw e; }
}
async function readPrivate(path: string, tighten: boolean) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (record(e) && e.code === "ENOENT") return; throw new CliError("unsafe_private_file", 1); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (!tighten && (stat.mode & 0o777) !== 0o600)) throw new CliError("unsafe_private_file", 1);
    if (tighten) await file.chmod(0o600);
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
export async function privateRead(path: string, tighten = false): Promise<string | undefined> {
  const parent = await privateParent(path);
  try { return await readPrivate(parent.path, tighten); } finally { await parent.directory.close(); }
}
export async function privateWrite(path: string, text: string, replace = false): Promise<void> {
  const parent = await privateParent(path);
  try {
    if (replace && await readPrivate(parent.path, false) === undefined) throw new CliError("private_file_missing", 1);
    const target = replace ? `${parent.path}.${crypto.randomUUID()}` : parent.path;
    const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.chmod(0o600); await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    if (replace) await rename(target, parent.path);
    await parent.directory.sync();
  } finally { await parent.directory.close(); }
}
export async function privateLock(path: string): Promise<() => Promise<void>> {
  try { await privateWrite(path, "locked\n"); }
  catch (e) { if (e instanceof CliError) throw e; throw new CliError("private_lock_recovery_required", record(e) && e.code === "EEXIST" ? 2 : 1, undefined, { path }); }
  return async () => {
    const parent = await privateParent(path);
    try { await rm(parent.path); } finally { await parent.directory.close(); }
  };
}
export function credentialValue(value: unknown): CredentialFile {
  if (!record(value) || Object.keys(value).some(k => !["url", "workspaceId", "principalId", "key"].includes(k))
    || typeof value.url !== "string" || typeof value.key !== "string") throw new CliError("credential_file_invalid", 1);
  const workspaceId = canonicalUuid(value.workspaceId), principalId = canonicalUuid(value.principalId);
  const config = (() => { try { return credentials({ BP_URL: value.url, BP_KEY: value.key }, "principal", workspaceId); } catch { throw new CliError("credential_file_invalid", 1); } })();
  if (new URL(config.url).origin !== value.url) throw new CliError("credential_origin_invalid", 1);
  return { url: value.url, workspaceId, principalId, key: value.key };
}
export async function credentialEnvironment(env: Environment): Promise<Environment> {
  if (!env.BP_CREDENTIALS_FILE) return env;
  const value = credentialValue(JSON.parse(await privateRead(env.BP_CREDENTIALS_FILE) ?? "null"));
  const loaded = { BP_URL: value.url, BP_WORKSPACE_ID: value.workspaceId, BP_PRINCIPAL_ID: value.principalId, BP_KEY: value.key };
  for (const [key, value] of Object.entries(loaded)) if (env[key] !== undefined && env[key] !== value) throw new CliError("credential_environment_conflict", 1);
  if (env.BP_AUTH_URL !== undefined && env.BP_AUTH_URL !== value.url) throw new CliError("credential_environment_conflict", 1);
  return { ...env, ...loaded };
}
