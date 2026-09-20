// Process configuration. Read once at startup by main.ts; everything else receives values.
import { isIP } from "node:net";

export type Config = {
  databaseUrl: string;
  port: number;
  dataDir: string;
  authSecret: string;
  publicOrigin: string;
  insecureOrigin: boolean;
  signup: "closed" | "open";
};

export class ConfigError extends Error {}

export function readAccessMode(env: Record<string, string | undefined>) {
  const mode = env.BP_ACCESS_MODE ?? "local";
  if (mode !== "local" && mode !== "public" && mode !== "proxy") throw new ConfigError("BP_ACCESS_MODE must be local, public or proxy");
  return mode;
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127."));
}

export function normalizeOrigin(value: string): string {
  const authority = /^https?:\/\/(\[[^\]]+\]|[^/:]+)(?::[0-9]+)?\/?$/i.exec(value);
  const host = authority?.[1];
  if (/[\s\\?#@%]/.test(value) || !host
    || (/(?:^|\.)(?:0x[\da-f]+|\d+)\.?$/i.test(host) && isIP(host) !== 4)) {
    throw new ConfigError("public URL must be an absolute HTTP(S) origin without credentials, path, query or fragment");
  }
  try { return new URL(value).origin; }
  catch { throw new ConfigError("public URL is invalid"); }
}

export function resolvePublicOrigin(env: Record<string, string | undefined>, fallback: string): string {
  const allow = env.BP_ALLOW_INSECURE_ORIGIN ?? "false";
  if (allow !== "true" && allow !== "false") throw new ConfigError("BP_ALLOW_INSECURE_ORIGIN must be true or false");
  const canonical = env.BP_PUBLIC_URL ? normalizeOrigin(env.BP_PUBLIC_URL) : undefined;
  const auth = env.BP_AUTH_URL ? normalizeOrigin(env.BP_AUTH_URL) : undefined;
  const origin = canonical ?? normalizeOrigin(fallback);
  if (auth && origin !== auth) throw new ConfigError("BP_PUBLIC_URL and BP_AUTH_URL must match");
  if (origin.startsWith("http:") && !isLoopbackHost(new URL(origin).hostname) && allow !== "true") {
    throw new ConfigError("non-loopback HTTP requires BP_ALLOW_INSECURE_ORIGIN=true");
  }
  return origin;
}

export function readConfig(env: Record<string, string | undefined>): Config {
  const accessMode = readAccessMode(env);
  if (env.BP_ADMIN_DATABASE_URL !== undefined) throw new ConfigError("BP_ADMIN_DATABASE_URL is forbidden in the server; run the migrate service");
  const databaseUrl = env.BP_DATABASE_URL;
  if (!databaseUrl) throw new ConfigError("BP_DATABASE_URL is required");
  const authSecret = env.BP_AUTH_SECRET;
  if (!authSecret) throw new ConfigError("BP_AUTH_SECRET is required");
  if (authSecret.length < 32) throw new ConfigError("BP_AUTH_SECRET must be at least 32 characters");
  const port = Number(env.BP_PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError("BP_PORT must be an integer between 1 and 65535");
  const signup = env.BP_SIGNUP ?? "closed";
  if (signup !== "closed" && signup !== "open") throw new ConfigError("BP_SIGNUP must be closed or open");
  if (accessMode !== "local" && !env.BP_PUBLIC_URL) throw new ConfigError("BP_PUBLIC_URL is required for public and proxy access modes");
  const publicOrigin = resolvePublicOrigin(env, `http://localhost:${port}`);
  if (accessMode === "public" && !publicOrigin.startsWith("https:")) throw new ConfigError("Public mode requires an HTTPS public origin");
  // Migrations run as the cluster owner; the server itself never holds a superuser credential (ADR-0001).
  return {
    signup, databaseUrl, port, dataDir: env.BP_DATA_DIR ?? "./data",
    authSecret, publicOrigin, insecureOrigin: publicOrigin.startsWith("http:"),
  };
}
