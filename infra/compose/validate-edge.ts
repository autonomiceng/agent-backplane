// Preparation resolves one origin before Compose starts any services.
import { isIP } from "node:net";
import { isLoopbackHost, normalizeOrigin, readAccessMode, resolvePublicOrigin } from "../../apps/server/platform/config.ts";

export function resolveAccess(env: Record<string, string | undefined>, edge = false) {
  const mode = readAccessMode(env);
  if (["BP_SCHEME", "BP_TLS_ISSUER", "BP_EDGE_CA", "BP_PUBLIC_HOST", "BP_EDGE_BIND_HOST"].some(key => env[key] !== undefined))
    throw new Error("Use BP_ACCESS_MODE, BP_PUBLIC_DOMAIN and BP_BIND_HOST for access settings");
  const host = `backplane.${env.BP_PUBLIC_DOMAIN || "localhost"}`.toLowerCase();
  if (edge && (host.length > 253 || !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))))
    throw new Error("BP_PUBLIC_DOMAIN must be a domain without scheme, port or path");
  const port = (name: string, fallback: string) => {
    const value = env[name] || fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`${name} must be a port between 1 and 65535`);
    return String(Number(value));
  };
  const httpPort = edge ? port("BP_HTTP_PORT", "80") : "80", httpsPort = edge ? port("BP_HTTPS_PORT", "443") : "443", serverPort = port("BP_PORT", "3000");
  const https = edge ? normalizeOrigin(`https://${host}:${httpsPort}`) : "";
  if (edge && mode === "proxy") throw new Error("Behind another gateway uses core only; omit --profile edge");
  if (mode === "public" && (!edge || !env.BP_PUBLIC_DOMAIN || !env.BP_PUBLIC_DOMAIN.includes(".") || isIP(env.BP_PUBLIC_DOMAIN) || env.BP_PUBLIC_DOMAIN.toLowerCase().endsWith(".localhost")))
    throw new Error("Public mode requires your own domain and --profile edge");
  if (mode === "proxy" && !env.BP_PUBLIC_URL) throw new Error("BP_PUBLIC_URL is required behind another gateway");
  const fallback = edge ? mode === "public" || env.BP_PUBLIC_DOMAIN ? https : normalizeOrigin(`http://localhost:${httpPort}`) : `http://localhost:${serverPort}`;
  const origin = resolvePublicOrigin(env, fallback);
  if (mode === "public" && origin !== https) throw new Error("BP_PUBLIC_URL must match the public HTTPS listener");
  if (mode === "local") {
    const url = new URL(origin);
    const expectedPort = edge ? url.protocol === "https:" ? httpsPort : httpPort : serverPort;
    if ((edge ? !["localhost", "127.0.0.1", host].includes(url.hostname) : !isLoopbackHost(url.hostname))
      || (url.port || (url.protocol === "https:" ? "443" : "80")) !== expectedPort
      || (!edge && url.protocol !== "http:")) throw new Error("BP_PUBLIC_URL must match a local listener");
  }
  const bind = env.BP_BIND_HOST || "127.0.0.1";
  if (edge && isIP(bind) !== 4 && bind !== "[::1]") throw new Error("BP_BIND_HOST must be an IP literal");
  if (edge && httpPort === httpsPort) throw new Error("HTTP and HTTPS ports must differ");
  return { mode, host, origin };
}

export function validateEdge(env: Record<string, string | undefined>) {
  return resolveAccess(env, true);
}

if (import.meta.main) {
  validateEdge(Bun.env);
  console.log("edge configuration valid");
}
