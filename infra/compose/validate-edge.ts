// Deployment preflight, called before Compose and by the real-ingress acceptance scenario.
import { isIP } from "node:net";
import { isLoopbackHost, resolvePublicOrigin } from "../../apps/server/platform/config.ts";

export function validateEdge(env: Record<string, string | undefined>) {
  const scheme = env.BP_SCHEME || "https";
  const host = env.BP_PUBLIC_HOST || `backplane.${env.BP_PUBLIC_DOMAIN || "localhost"}`;
  const ca = env.BP_EDGE_CA || env.BP_TLS_ISSUER || "none";
  if (env.BP_CADDY_DIGEST !== undefined && !/^[0-9a-f]{64}$/.test(env.BP_CADDY_DIGEST)) throw new Error("BP_CADDY_DIGEST must be a 64-character lowercase SHA-256 digest");
  if (scheme !== "https") throw new Error("BP_SCHEME must be https for the edge overlay");
  if (host.length > 253 || !host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    || isIP(host)) throw new Error("BP_PUBLIC_HOST must be a hostname without scheme, port or path");
  if (ca !== "acme" && ca !== "internal") throw new Error("BP_TLS_ISSUER must be acme or internal when BP_SCHEME=https");
  const bind = env.BP_BIND_HOST || "127.0.0.1";
  if (!(isIP(bind) === 4 && isLoopbackHost(bind)) && bind !== "[::1]") throw new Error("BP_BIND_HOST must be a loopback IP literal");
  const port = env.BP_HTTPS_PORT || "443";
  const expected = `https://${host.toLowerCase()}${port === "443" ? "" : `:${port}`}`;
  const origin = resolvePublicOrigin(env, expected);
  if (origin !== expected) throw new Error("BP_PUBLIC_URL must match the edge HTTPS origin");
  return { host, ca, origin };
}

if (import.meta.main) {
  validateEdge(Bun.env);
  console.log("edge configuration valid");
}
