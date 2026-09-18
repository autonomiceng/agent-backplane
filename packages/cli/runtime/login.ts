// User sessions are scoped to the server and email digest; only the cookie is persisted.
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { CliError, credentials, type Credentials, type Environment } from "./credentials.ts";
import { safeDirectory } from "./secure-directory.ts";
import { request, record } from "./http.ts";
import type { Execution } from "./execute.ts";
const cookiePattern = /^(?:__Secure-)?better-auth\.session_token=[^;\s]+$/;
function session(config: Credentials, env: Environment) {
  if (!env.BP_USER_EMAIL) throw new CliError("BP_USER_EMAIL_required");
  const origin = config.url;
  const identity = createHash("sha256").update(JSON.stringify([config.url, env.BP_USER_EMAIL.trim().toLowerCase()])).digest("hex");
  const directory = join(dirname(config.directory), "sessions");
  return { origin, directory, path: join(directory, `${identity}.cookie`) };
}
export async function sessionHeaders(config: Credentials, env: Environment): Promise<Headers> {
  const entry = session(config, env);
  await safeDirectory(dirname(entry.directory)); await safeDirectory(entry.directory);
  let file;
  try { file = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new CliError(record(error) && error.code === "ENOENT" ? "user_session_required" : "unsafe_session_file"); }
  try {
    const stat = await file.stat(), cookie = await file.readFile("utf8");
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || !cookiePattern.test(cookie)) throw new CliError("unsafe_session_file");
    return new Headers({ cookie, origin: entry.origin, "content-type": "application/json" });
  } finally { await file.close(); }
}
export async function login(io: Execution, logout = false): Promise<{ authenticated: boolean }> {
  const config = credentials(io.env, "user", undefined), entry = session(config, io.env);
  await safeDirectory(dirname(entry.directory)); await safeDirectory(entry.directory);
  if (logout) { await rm(entry.path, { force: true }); return { authenticated: false }; }
  if (!io.env.BP_USER_PASSWORD) throw new CliError("BP_USER_PASSWORD_required");
  const response = await request(config, "/api/auth/sign-in/email", "POST",
    JSON.stringify({ email: io.env.BP_USER_EMAIL, password: io.env.BP_USER_PASSWORD }),
    new Headers({ origin: entry.origin, "content-type": "application/json" }), undefined, io.signal, io.transport);
  if (!response.ok) throw new CliError("login_failed", 1, response.status);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0] ?? "").find((value) => cookiePattern.test(value));
  if (!cookie) throw new CliError("session_cookie_missing", 1);
  const temporary = `${entry.path}.${randomUUID()}`;
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(cookie); await file.sync(); } finally { await file.close(); }
    await rename(temporary, entry.path);
  } finally { await rm(temporary, { force: true }); }
  return { authenticated: true };
}
