// Environment-only CLI configuration and the error boundary's secret redaction.
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
export type Environment = Record<string, string | undefined>;
export class CliError extends Error {
  constructor(public readonly error: string, public readonly exit = 2, public readonly status?: number, public readonly details?: unknown) { super(error); }
}
export function credentials(env: Environment, auth: string, workspaceId: string | undefined) {
  const origins = [env.BP_PUBLIC_URL, env.BP_URL, env.BP_AUTH_URL].filter(value => Boolean(value)).map(value => {
    const host = value?.match(/^https?:\/\/(\[[^\]]+\]|[^/:]+)(?::[0-9]+)?\/?$/i)?.[1];
    if (!value || /[\s\\?#@%]/.test(value) || !host
      || (/(?:^|\.)(?:0x[\da-f]+|\d+)\.?$/i.test(host) && isIP(host) !== 4)) throw new CliError("BP_URL_invalid");
    let url: URL;
    try { url = new URL(value); } catch { throw new CliError("BP_URL_invalid"); }
    if (url.protocol === "http:" && !(["localhost", "[::1]"].includes(url.hostname)
      || (isIP(url.hostname) === 4 && url.hostname.startsWith("127.")))) throw new CliError("BP_URL_invalid");
    return url.origin;
  });
  const url = origins[0];
  if (!url) throw new CliError("BP_URL_required");
  if (origins.some(origin => origin !== url)) throw new CliError("BP_URL_conflict");
  const key = ["none", "user"].includes(auth) ? "" : env.BP_KEY ?? "";
  if (!["none", "user"].includes(auth) && !/^bp_[0-9a-f]{24}_[0-9a-f]{64}$/.test(key)) throw new CliError("BP_KEY_invalid");
  return { url, key, workspaceId: workspaceId?.toLowerCase() ?? "", session: env.BP_SESSION ?? "default",
    directory: env.BP_DATA_DIR ? join(env.BP_DATA_DIR, "cli", "runs") : join(env.XDG_STATE_HOME ?? join(env.HOME ?? homedir(), ".local", "state"), "backplane", "runs") };
}
export function redact(text: string, env: Environment, secrets: string[] = []): string {
  const key = env.BP_KEY;
  for (const secret of [...secrets, env.BP_USER_EMAIL, env.BP_USER_PASSWORD, env.BP_BOOTSTRAP_PASSWORD, env.BP_ADMIN_DATABASE_URL, ...(key ? [key, key.split("_")[2] ?? ""] : [])]) if (secret) {
    text = text.replaceAll(JSON.stringify(secret).slice(1, -1), "[REDACTED]").replaceAll(secret, "[REDACTED]");
  }
  return text.replace(/bp_[0-9a-f]{24}_[0-9a-f]{64}/g, "[REDACTED]");
}
export type Credentials = ReturnType<typeof credentials>;
