import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

const publicSettings = [
  "BP_PUBLIC_DOMAIN=example.com",
  "BP_SCHEME=https",
  "BP_TLS_ISSUER=internal",
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
  expect(core.services.server.environment.BP_PUBLIC_URL).toBe("http://localhost:3000");
  const edge = await config(["compose.edge.yaml"], "edge", [
    "BP_PUBLIC_DOMAIN=example.com",
    "BP_SCHEME=https",
    "BP_TLS_ISSUER=acme",
  ]);
  expect(edge.services.server.environment.BP_PUBLIC_URL).toBe("https://backplane.example.com");
  expect(edge.services.edge.environment.BP_PUBLIC_HOST).toBe("backplane.example.com");
});

test("edge derives the public hostname from BP_PUBLIC_DOMAIN", async () => {
  const rendered = await config(["compose.edge.yaml"], "edge");
  expect(rendered.services.edge.environment.BP_PUBLIC_HOST).toBe("backplane.example.com");
  expect(rendered.services.edge.environment.BP_EDGE_CA).toBe("internal");
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
