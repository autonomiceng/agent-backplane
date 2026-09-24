// Public Status Document, contract 2 (docs/conventions.md "Status v2"). Everything here is configuration
// read once at startup; the operations document never reaches this projection.
import { Elysia } from "elysia";
import type { CapabilitySampler } from "./capability-types.ts";
import type { Pool } from "./pool.ts";
import { probeTransaction } from "./probe-transaction.ts";

export const statusComponents = ["server", "postgres", "rustfs", "workerd", "caddy"] as const;
type ComponentId = typeof statusComponents[number];
const names = { server: "Backplane", postgres: "PostgreSQL", rustfs: "RustFS", workerd: "Functions runtime", caddy: "Caddy" } as const;
const kinds = { server: "app", postgres: "datastore", rustfs: "datastore", workerd: "runtime", caddy: "gateway" } as const;

export type StatusConfig = ReturnType<typeof readStatusConfig>;
export function readStatusConfig(env: Record<string, string | undefined>, publicOrigin: string) {
  return {
    configuredAt: new Date().toISOString(), url: publicOrigin, backupsConfigured: Boolean(env.BP_BACKUP_DIR),
    images: { server: env.BP_SERVER_IMAGE, postgres: env.BP_POSTGRES_IMAGE, rustfs: env.BP_RUSTFS_IMAGE, workerd: env.BP_WORKERD_IMAGE, caddy: env.BP_CADDY_IMAGE },
    // Overlays select optional components: blobs sets the S3 backend, compute the launcher URL, edge and gateway the Caddy flag.
    enabled: { server: true, postgres: true, rustfs: env.BP_BLOB_BACKEND === "s3", workerd: Boolean(env.BP_COMPUTE_URL), caddy: env.BP_CADDY_ENABLED === "true" },
  };
}

// The release version parsed from a reference's tag, or null when the tag is not a release of that component.
// A workerd tag carrying the compatibility date (1.20260918.1) identifies a build, not a release.
const releases: Record<ComponentId, RegExp> = { server: /^v?\d+\.\d+\.\d+$/, postgres: /^\d+(?:\.\d+){1,2}$/, rustfs: /^v?\d+\.\d+\.\d+$/, workerd: /^v?\d{1,4}(?:\.\d{1,4}){2}$/, caddy: /^\d+\.\d+\.\d+$/ };
export function releaseVersion(id: ComponentId, image: string) {
  const tag = image.slice(image.lastIndexOf("/") + 1).split(":")[1];
  return tag !== undefined && releases[id].test(tag) ? tag : null;
}

export type StatusSample = { backup: { completedAt: string } | null };
export function publicStatus(sample: StatusSample, config: StatusConfig) {
  const components = statusComponents.flatMap(id => {
    const reference = config.images[id];
    // A component without a configured reference is not reported rather than invented.
    if (!reference) return [];
    const image = reference.replace(/@sha256:[0-9a-f]{64}$/, "");
    return [{ id, name: names[id], kind: kinds[id], enabled: config.enabled[id], image, version: releaseVersion(id, image), health: `/health/${id}` as const,
      ...(id === "server" ? { url: config.url } : {}) }];
  });
  return { contract: 2 as const, stack: "backplane" as const, configuredAt: config.configuredAt, components,
    features: { backups: { configured: config.backupsConfigured, lastCheckpointAt: sample.backup?.completedAt ?? null } } };
}

// GET /status.json and GET /health/<component> are public in every access mode; bodies carry no diagnostics.
export function statusRoute(config: StatusConfig, sample: () => Promise<StatusSample>, pool: Pool, capabilities?: CapabilitySampler) {
  const headers = { "cache-control": "no-store" };
  const capability = (name: "files" | "functions") => Promise.resolve(capabilities?.()).then(sample => sample?.[name].state === "healthy" ? 200 : 503, () => 503);
  const probe = (id: Exclude<ComponentId, "server">, run: () => Promise<number>) => async () => new Response(null, { status: config.enabled[id] ? await run() : 404, headers });
  const detail = { hide: true };
  return new Elysia({ name: "status" })
    .get("/status.json", async () => Response.json(publicStatus(await sample(), config), { headers }), { detail })
    .all("/status.json", () => new Response(null, { status: 405, headers: { ...headers, allow: "GET, HEAD" } }), { detail })
    .get("/health/postgres", probe("postgres", () => probeTransaction(pool, 2000, async tx => { await tx`SELECT 1`; return 200; }).catch(() => 503)), { detail })
    .get("/health/rustfs", probe("rustfs", () => capability("files")), { detail })
    .get("/health/workerd", probe("workerd", () => capability("functions")), { detail })
    // Caddy answers its own path in front of the server; here the component is absent or disabled.
    .get("/health/caddy", probe("caddy", async () => 404), { detail });
}
