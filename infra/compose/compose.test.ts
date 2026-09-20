import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig } from "../../apps/server/platform/config.ts";
import { resolveAccess } from "./validate-edge.ts";

const root = resolve(import.meta.dir, "../..");

const publicSettings = [
  "BP_PUBLIC_DOMAIN=example.com",
  "BP_ACCESS_MODE=local",
  "BP_PUBLIC_URL=https://backplane.example.com:8443",
  "BP_BIND_HOST=127.0.0.1",
  "BP_PORT=3300",
  "BP_POSTGRES_PORT=55432",
  "BP_HTTP_PORT=8080",
  "BP_HTTPS_PORT=8443",
];

async function config(overlays: string[] = [], profile?: string, settings = publicSettings) {
  const directory = await mkdtemp(join(tmpdir(), "bp-compose-config-"));
  const backup = join(directory, "backup");
  await mkdir(backup);
  const env = join(directory, ".env");
  await Bun.write(env, [
    `BP_BACKUP_DIR=${backup}`,
    `BP_AUTH_SECRET=${"a".repeat(32)}`,
    "BP_POSTGRES_ADMIN_PASSWORD=admin-test-password",
    "BP_POSTGRES_PASSWORD=server-test-password",
    ...settings,
  ].join("\n"));
  const args = ["docker", "compose", "--project-directory", root, "--env-file", env,
    "-f", join(root, "compose.yaml"), ...overlays.flatMap(file => ["-f", join(root, file)]),
    ...(profile ? ["--profile", profile] : []), "config", "--format", "json"];
  try {
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("compose renders valid local and HTTPS public origins", async () => {
  const core = await config([], undefined, []);
  expect(readConfig(core.services.server.environment).publicOrigin).toBe("http://localhost:3000");
  const edge = await config(["compose.edge.yaml"], "edge", [
    "BP_PUBLIC_DOMAIN=example.com",
    "BP_ACCESS_MODE=public",
    "BP_PUBLIC_URL=https://backplane.example.com",
  ]);
  expect(edge.services.server.environment.BP_PUBLIC_URL).toBe("https://backplane.example.com");
  expect(edge.services.edge.environment.BP_EDGE_HOST).toBe("backplane.example.com");
});

test("edge derives the public hostname from BP_PUBLIC_DOMAIN", async () => {
  const rendered = await config(["compose.edge.yaml"], "edge");
  expect(rendered.services.edge.environment.BP_EDGE_HOST).toBe("backplane.example.com");
  expect(rendered.services.edge.environment.BP_ACCESS_MODE).toBe("local");
  expect(rendered.services.server.environment.BP_PUBLIC_URL).toBe("https://backplane.example.com:8443");
});

test("compose publishes only the expected loopback ports", async () => {
  const core = await config();
  expect(core.services.edge).toBeUndefined();
  expect(core.services.server.ports).toEqual([{ mode: "ingress", target: 3000, published: "3300", protocol: "tcp", host_ip: "127.0.0.1" }]);
  // Core keeps Postgres private; only the development overlay publishes it.
  expect(core.services.postgres.ports).toBeUndefined();
  const dev = await config(["compose.dev.yaml"]);
  expect(dev.services.postgres.ports).toEqual([{ mode: "ingress", target: 5432, published: "55432", protocol: "tcp", host_ip: "127.0.0.1" }]);
  const edge = await config(["compose.edge.yaml"], "edge");
  expect(edge.services.edge.ports).toEqual([
    { mode: "ingress", target: 80, published: "8080", protocol: "tcp", host_ip: "127.0.0.1" },
    { mode: "ingress", target: 443, published: "8443", protocol: "tcp", host_ip: "127.0.0.1" },
  ]);
});

test("proxy uses the gateway origin on core HTTP without a standalone edge", async () => {
  const settings = { BP_ACCESS_MODE: "proxy", BP_PUBLIC_URL: "https://backplane.example.com" };
  expect(resolveAccess(settings)).toMatchObject({ mode: "proxy", origin: settings.BP_PUBLIC_URL });
  const proxy = await config([], undefined, Object.entries(settings).map(([key, value]) => `${key}=${value}`));
  expect(proxy.services.edge).toBeUndefined();
  expect(proxy.services.server.environment.BP_ACCESS_MODE).toBe("proxy");
  expect(proxy.services.server.environment.BP_PUBLIC_URL).toBe(settings.BP_PUBLIC_URL);
  expect(proxy.services.server.environment.BP_PORT).toBe("3000");
  expect(proxy.services.server.networks.platform.aliases).toEqual(["bp-server"]);
  expect(proxy.volumes["server-data"].name).toBe("agent-backplane_server-data");
  const missing = await config([], undefined, ["BP_ACCESS_MODE=proxy"]);
  expect(() => readConfig(missing.services.server.environment)).toThrow("BP_PUBLIC_URL is required");
});

test("every merged service uses journald without a Docker file cache or Alloy dependency", async () => {
  const rendered = await config(["compose.blobs.yaml", "compose.compute.yaml", "compose.edge.yaml", "compose.dev.yaml"], "*", [
    ...publicSettings,
    `BP_BLOB_BOOTSTRAP_IMAGE=fixture@sha256:${"a".repeat(64)}`,
    "BP_RUSTFS_ROOT_USER=fixture", "BP_RUSTFS_ROOT_PASSWORD=fixture",
    "BP_BLOB_S3_ACCESS_KEY=fixture", "BP_BLOB_S3_SECRET_KEY=fixture",
    "BP_COMPUTE_TOKEN=fixture", "BP_WORKERD_REPOSITORY=fixture", `BP_WORKERD_DIGEST=${"a".repeat(64)}`,
  ]);
  for (const service of Object.values(rendered.services)) {
    expect(service).toMatchObject({ logging: { driver: "journald", options: { "cache-disabled": "true" } } });
  }
  expect(JSON.stringify(rendered)).not.toMatch(/alloy|json-file|\/var\/log/);
  expect(rendered.services.rustfs.environment.RUSTFS_OBS_LOG_DIRECTORY).toBe("");
});

 test("internal gateway retains routing without publishing host ports", async () => {
  const rendered = await config(["compose.gateway.yaml"], "gateway", ["BP_ACCESS_MODE=proxy", "BP_PUBLIC_URL=https://backplane.example.com"]);
  expect(rendered.services.edge.ports ?? []).toEqual([]);
  expect(rendered.services.edge.environment.BP_ACCESS_MODE).toBe("proxy");
  expect(rendered.services.edge.networks.platform.aliases).toEqual(["bp-gateway"]);
  expect(rendered.services.edge.logging).toEqual({ driver: "journald", options: { "cache-disabled": "true" } });
  expect(rendered.services.postgres.networks.platform).toBeUndefined();
});
