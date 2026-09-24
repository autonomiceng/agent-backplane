import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readConfig } from "../../apps/server/platform/config.ts";

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

async function config(overlays: string[] = [], profile?: string, settings = publicSettings, failure?: string) {
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
    const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe",
      env: Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith("BP_") && !key.startsWith("COMPOSE_"))),
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (failure) { expect(code).not.toBe(0); expect(stderr).toContain(failure); return null; }
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

test("proxy mode is core behind Platform Edge: no Caddy overlay and no gateway file set", async () => {
  const settings = { BP_ACCESS_MODE: "proxy", BP_PUBLIC_URL: "https://backplane.example.com" };
  const files = (await readdir(root)).filter(name => /^compose.*\.ya?ml$/.test(name)).sort();
  expect(files).toEqual(["compose.blobs.yaml", "compose.compute.yaml", "compose.dev.yaml", "compose.edge.yaml", "compose.enroll.yaml", "compose.yaml"]);
  const proxy = await config([], undefined, Object.entries(settings).map(([key, value]) => `${key}=${value}`));
  expect(proxy.services.edge).toBeUndefined();
  expect(Object.keys(proxy.services).sort()).toEqual(["migrate", "postgres", "server", "storage-init"]);
  const everything = await config(["compose.blobs.yaml", "compose.compute.yaml", "compose.edge.yaml"], "*", [
    ...Object.entries(settings).map(([key, value]) => `${key}=${value}`),
    "BP_RUSTFS_ROOT_USER=fixture", "BP_RUSTFS_ROOT_PASSWORD=fixture", "BP_BLOB_S3_ACCESS_KEY=fixture", "BP_BLOB_S3_SECRET_KEY=fixture", "BP_COMPUTE_TOKEN=fixture",
    // Unsupported settings left in an env file never reach a container.
    "BP_AUTH_URL=https://backplane.example.com", `BP_WORKERD_DIGEST=sha256:${"a".repeat(64)}`, "BP_WORKERD_REPOSITORY=registry.example/workerd",
  ]);
  expect(Object.keys(everything.services).sort()).toEqual(["blob-bootstrap", "edge", "migrate", "postgres", "rustfs", "server", "storage-init", "workerd"]);
  expect(JSON.stringify(everything)).not.toMatch(/BP_AUTH_URL|BP_WORKERD_DIGEST|BP_WORKERD_REPOSITORY/);
  // The standalone edge is the only Caddy: loopback ports, project network only, no proxy or console settings.
  expect(Object.keys(everything.services.edge.networks)).toEqual(["default"]);
  expect(Object.keys(everything.services.edge.environment).sort()).toEqual(["BP_ACCESS_MODE", "BP_EDGE_HOST", "BP_PUBLIC_URL"]);
  expect(everything.services.edge.ports.map((port: { host_ip: string }) => port.host_ip)).toEqual(["127.0.0.1", "127.0.0.1"]);
  expect(everything.services.rustfs.environment.RUSTFS_CONSOLE_ENABLE).toBe("true");
  expect(Object.keys(everything.services.rustfs.networks)).toEqual(["blob-internal"]);
  expect(JSON.stringify(everything)).not.toMatch(/bp-gateway|TRUSTED_PROXIES|RUSTFS_CONSOLE_ALLOW|BP_RUSTFS_URL|BP_RUSTFS_HOST|BP_RUSTFS_AUTHORITY/);
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
    "BP_COMPUTE_TOKEN=fixture", "BP_WORKERD_IMAGE=fixture:local", `BP_WORKERD_BINARY_SHA256=${"a".repeat(64)}`,
  ]);
  for (const service of Object.values(rendered.services)) {
    expect(service).toMatchObject({ logging: { driver: "journald", options: { "cache-disabled": "true" } } });
  }
  expect(JSON.stringify(rendered)).not.toMatch(/alloy|json-file|\/var\/log/);
  expect(rendered.services.rustfs.environment.RUSTFS_OBS_LOG_DIRECTORY).toBe("");
});

 test("bare Compose defaults to published digest-pinned images; only the development overlay builds", async () => {
  const blobs = ["BP_RUSTFS_ROOT_USER=fixture", "BP_RUSTFS_ROOT_PASSWORD=fixture", "BP_BLOB_S3_ACCESS_KEY=fixture", "BP_BLOB_S3_SECRET_KEY=fixture", "BP_COMPUTE_TOKEN=fixture"];
  const published = await config(["compose.blobs.yaml", "compose.compute.yaml"], "*", blobs);
  const server = /^ghcr\.io\/autonomiceng\/agent-backplane-server:[\w.-]+@sha256:[a-f0-9]{64}$/;
  expect(published.services.server.image).toMatch(server);
  for (const name of ["migrate", "storage-init", "blob-bootstrap"]) expect(published.services[name].image).toBe(published.services.server.image);
  expect(published.services["blob-bootstrap"].environment.BP_BLOB_BOOTSTRAP_IMAGE).toBe(published.services.server.image);
  expect(published.services.workerd.image).toMatch(/^ghcr\.io\/autonomiceng\/agent-backplane-workerd:[\w.-]+@sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify(published.services)).not.toMatch(/"(build|pull_policy)":/);
  const dev = await config(["compose.blobs.yaml", "compose.compute.yaml", "compose.dev.yaml"], "*", blobs);
  for (const name of ["migrate", "storage-init", "server"]) expect(dev.services[name]).toMatchObject({ image: "agent-backplane-server:local",
    build: { context: root, dockerfile: "infra/compose/server.Dockerfile" } });
  expect(dev.services["blob-bootstrap"].image).toBe("agent-backplane-server:local");
  expect(dev.services["blob-bootstrap"].environment.BP_BLOB_BOOTSTRAP_IMAGE).toBe("agent-backplane-server:local");
  expect(dev.services.workerd).toMatchObject({ image: "agent-backplane-workerd:local", platform: "linux/amd64",
    build: { context: join(root, "infra/compute/image") }, environment: { BP_WORKERD_IMAGE: "agent-backplane-workerd:local" } });
  const operator = await config(["compose.dev.yaml"], undefined, ["BP_SERVER_IMAGE=server:operator"]);
  expect(operator.services.server.image).toBe("server:operator");
});

test("only migrate, storage-init and blob-bootstrap run once before the server; postgres and storage-init prepare their own mounts", async () => {
  const core = await config();
  expect(Object.keys(core.services).sort()).toEqual(["migrate", "postgres", "server", "storage-init"]);
  const blobs = await config(["compose.blobs.yaml"], "blobs", ["BP_RUSTFS_ROOT_USER=fixture", "BP_RUSTFS_ROOT_PASSWORD=fixture", "BP_BLOB_S3_ACCESS_KEY=fixture", "BP_BLOB_S3_SECRET_KEY=fixture"]);
  expect(Object.keys(blobs.services).sort()).toEqual(["blob-bootstrap", "migrate", "postgres", "rustfs", "server", "storage-init"]);
  expect(Object.keys(blobs.services.server.depends_on).sort()).toEqual(["blob-bootstrap", "migrate", "postgres", "storage-init"]);
  expect(blobs.services.postgres.depends_on).toBeUndefined();
  expect(blobs.services.postgres.entrypoint.slice(0, 2)).toEqual(["sh", "-ec"]);
  expect(blobs.services.postgres.entrypoint[2]).toBe("mkdir -p /backup/archive && chown postgres:postgres /backup/archive && "
    + "if [ ! -d /backup/backups ]; then mkdir /backup/backups && chown postgres:postgres /backup/backups; fi && exec docker-entrypoint.sh \"$$@\"");
  expect(blobs.services.rustfs.depends_on).toBeUndefined();
  expect(blobs.services["storage-init"]).toMatchObject({ user: "0:0", command: ["bun", "apps/server/blobs/storage-admin.ts", "initialize"] });
  expect(blobs.services["storage-init"].entrypoint.slice(0, 2)).toEqual(["sh", "-ec"]);
  expect(blobs.services["storage-init"].entrypoint[2]).toMatch(/^chown -R bun:bun \/data; exec setpriv --reuid=bun --regid=bun --init-groups -- /);
  for (const name of ["postgres", "migrate", "server", "rustfs", "blob-bootstrap"]) expect(blobs.services[name].user).toBeUndefined();
});

test("bare Compose preserves explicit workerd image selection", async () => {
  const digest = "a".repeat(64);
  const settings = ["BP_COMPUTE_TOKEN=fixture", "BP_WORKERD_IMAGE=fixture:local", `BP_WORKERD_BINARY_SHA256=${digest}`];
  const tagged = await config(["compose.compute.yaml"], "compute", settings);
  expect(tagged.services.workerd.image).toBe("fixture:local");
  expect(tagged.services.workerd.environment.BP_WORKERD_HOST_IMAGE_ID).toBe("");
  expect(tagged.services.workerd.pull_policy).toBeUndefined();
  expect(tagged.services.workerd.entrypoint).toEqual(["/bin/sh", "/compute/start.sh"]);
  expect(tagged.services.server.environment.BP_WORKERD_RUNTIME_ID).toBe(`workerd-binary-sha256:${digest}`);
  const pinned = await config(["compose.compute.yaml"], "compute", [...settings, `BP_WORKERD_EFFECTIVE_IMAGE=sha256:${digest}`, `BP_WORKERD_HOST_IMAGE_ID=sha256:${digest}`]);
  expect(pinned.services.workerd.image).toBe(`sha256:${digest}`);
  expect(pinned.services.workerd.environment.BP_WORKERD_IMAGE).toBe("fixture:local");
  expect(pinned.services.workerd.environment.BP_WORKERD_HOST_IMAGE_ID).toBe(`sha256:${digest}`);
  const edited = await config(["compose.compute.yaml"], "compute", ["BP_COMPUTE_TOKEN=fixture", "BP_WORKERD_IMAGE=fixture:edited"]);
  expect(edited.services.workerd.image).toBe("fixture:edited");
  expect(edited.services.workerd.environment.BP_WORKERD_HOST_IMAGE_ID).toBe("");
  const local = await config(["compose.compute.yaml"], "compute", ["BP_COMPUTE_TOKEN=fixture"]);
  const empty = await config(["compose.compute.yaml"], "compute", ["BP_COMPUTE_TOKEN=fixture", "BP_WORKERD_IMAGE="]);
  expect(local.services.workerd.image).toMatch(/^ghcr\.io\/autonomiceng\/agent-backplane-workerd:[\w.-]+@sha256:[a-f0-9]{64}$/);
  expect(empty.services.workerd.image).toBe(local.services.workerd.image);
  expect(local.services.workerd.environment.BP_WORKERD_IMAGE).toBe(local.services.workerd.image);
  expect(empty.services.workerd.environment.BP_WORKERD_IMAGE).toBe(local.services.workerd.image);
  expect(local.services.workerd.environment.BP_WORKERD_HOST_IMAGE_ID).toBe("");
});

test("workerd shares only the compute network, and only with the server", async () => {
  const rendered = await config(["compose.blobs.yaml", "compose.compute.yaml", "compose.dev.yaml"], "*", [
    "BP_ACCESS_MODE=proxy", "BP_PUBLIC_URL=https://backplane.example.com",
    "BP_RUSTFS_ROOT_USER=fixture", "BP_RUSTFS_ROOT_PASSWORD=fixture",
    "BP_BLOB_S3_ACCESS_KEY=fixture", "BP_BLOB_S3_SECRET_KEY=fixture", "BP_COMPUTE_TOKEN=fixture",
  ]);
  expect(Object.keys(rendered.services.workerd.networks)).toEqual(["compute"]);
  const members = Object.keys(rendered.services).filter(name => "compute" in (rendered.services[name].networks ?? {}));
  expect(members.sort()).toEqual(["server", "workerd"]);
  expect(rendered.services.server.environment.BP_COMPUTE_URL).toBe("http://workerd:8080");
});

test("enrollment runs the CLI from the server image on the host network without a forced password", async () => {
  const enroll = await config(["compose.enroll.yaml"], "enroll", []);
  expect(enroll.services.enroll.image).toBe(enroll.services.server.image);
  expect(enroll.services.enroll.network_mode).toBe("host");
  expect(enroll.services.enroll.entrypoint).toEqual(["bun", "packages/cli/runtime/main.ts", "bootstrap", "--capability-file", "/tmp/capability"]);
  // An empty BP_BOOTSTRAP_PASSWORD would be taken as the password; unset renders as null (not passed).
  expect(enroll.services.enroll.environment.BP_BOOTSTRAP_PASSWORD).toBeNull();
  expect(enroll.services.enroll.ports).toBeUndefined();
  const up = await config(["compose.enroll.yaml"], undefined, []);
  expect(up.services.enroll).toBeUndefined();
});

test("the server receives every configured image reference and Caddy proxies /status.json to it", async () => {
  const rendered = await config(["compose.blobs.yaml", "compose.compute.yaml", "compose.edge.yaml"], "*", [
    ...publicSettings,
    "BP_RUSTFS_ROOT_USER=fixture", "BP_RUSTFS_ROOT_PASSWORD=fixture", "BP_BLOB_S3_ACCESS_KEY=fixture", "BP_BLOB_S3_SECRET_KEY=fixture", "BP_COMPUTE_TOKEN=fixture",
  ]);
  const environment = rendered.services.server.environment;
  // Renovate moves the image: lines; these pass-throughs must move with them.
  expect(environment.BP_SERVER_IMAGE).toBe(rendered.services.server.image);
  expect(environment.BP_POSTGRES_IMAGE).toBe(rendered.services.postgres.image);
  expect(environment.BP_RUSTFS_IMAGE).toBe(rendered.services.rustfs.image);
  expect(environment.BP_WORKERD_IMAGE).toBe(rendered.services.workerd.image);
  expect(environment.BP_CADDY_IMAGE).toBe(rendered.services.edge.image);
  expect(environment.BP_CADDY_ENABLED).toBe("true");
  expect(rendered.services.edge.init).toBeUndefined();
  expect(rendered.services.edge.volumes.map((volume: { target: string }) => volume.target)).toEqual(["/etc/caddy/Caddyfile", "/data", "/config"]);
  const core = await config();
  expect(core.services.server.environment.BP_CADDY_ENABLED).toBeUndefined();
  expect(core.services.server.environment.BP_CADDY_IMAGE).toBe(rendered.services.edge.image);
  const standalone = await config(["compose.edge.yaml"], "edge");
  expect(standalone.services.server.environment.BP_CADDY_ENABLED).toBe("true");
  const dev = await config(["compose.compute.yaml", "compose.dev.yaml"], "compute", [...publicSettings, "BP_COMPUTE_TOKEN=fixture"]);
  expect(dev.services.server.environment.BP_SERVER_IMAGE).toBe(dev.services.server.image);
  expect(dev.services.server.environment.BP_WORKERD_IMAGE).toBe(dev.services.workerd.image);

  const adapt = Bun.spawn(["docker", "run", "--rm", "-e", "BP_ACCESS_MODE=local", "-e", "BP_EDGE_HOST=backplane.example.com", "-e", "BP_PUBLIC_URL=http://localhost",
    "-v", `${join(root, "infra/compose/Caddyfile")}:/etc/caddy/Caddyfile:ro`, standalone.services.edge.image, "caddy", "adapt", "--config", "/etc/caddy/Caddyfile"],
    { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(adapt.stdout).text(), new Response(adapt.stderr).text(), adapt.exited]);
  expect(code, stderr).toBe(0);
  const servers = JSON.parse(stdout).apps.http.servers;
  expect(JSON.stringify(servers)).not.toContain("trusted_proxies");
  const http = Object.values(servers as Record<string, { listen: string[]; routes: never[] }>).find(server => server.listen.includes(":80"));
  expect(http).toBeDefined();
  const routes = http?.routes ?? [];
  type Route = { match?: { path?: string[] }[]; handle?: { routes?: Route[] }[] };
  const find = (list: Route[], path: string): Route | undefined => {
    for (const route of list) {
      if (route.match?.some(m => m.path?.includes(path))) return route;
      const nested = find(route.handle?.flatMap(h => h.routes ?? []) ?? [], path);
      if (nested) return nested;
    }
  };
  const status = JSON.stringify(find(routes, "/status.json"));
  expect(status).toContain('"upstreams":[{"dial":"server:3000"}]');
  expect(status).not.toMatch(/file_server|\/srv\/status/);
  expect(status).toContain('"Cache-Control":["no-store"]');
  expect(JSON.stringify(routes)).toContain('"/health/caddy"');
}, 30000);
