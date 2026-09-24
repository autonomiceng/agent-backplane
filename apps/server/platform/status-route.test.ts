import { afterAll, describe, expect, test } from "bun:test";
import { testApp } from "../testing/session.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { createPool, type Pool } from "./pool.ts";
import { publicStatus, readStatusConfig, releaseVersion, statusComponents } from "./status-route.ts";

const digest = "@sha256:" + "a".repeat(64);
// platform-edge docs/operations/status-fixtures/v2-backplane.json, the frozen contract 2 example for this stack.
const fixture = {
  contract: 2, stack: "backplane", configuredAt: "2026-09-23T16:10:00Z",
  components: [
    { id: "server", name: "Backplane", kind: "app", enabled: true, image: "ghcr.io/autonomiceng/agent-backplane-server:0.9.0", version: "0.9.0", health: "/health/server", url: "https://backplane.example.com" },
    { id: "postgres", name: "PostgreSQL", kind: "datastore", enabled: true, image: "postgres:18.6", version: "18.6", health: "/health/postgres" },
    { id: "rustfs", name: "RustFS", kind: "datastore", enabled: false, image: "rustfs/rustfs:1.0.0", version: "1.0.0", health: "/health/rustfs" },
    { id: "workerd", name: "Functions runtime", kind: "runtime", enabled: false, image: "ghcr.io/autonomiceng/agent-backplane-workerd:1.20260918.1", version: null, health: "/health/workerd" },
    { id: "caddy", name: "Caddy", kind: "gateway", enabled: false, image: "caddy:2.11.4", version: "2.11.4", health: "/health/caddy" },
  ],
  features: { backups: { configured: true, lastCheckpointAt: "2026-09-23T02:00:00Z" } },
};
const images = {
  BP_SERVER_IMAGE: "ghcr.io/autonomiceng/agent-backplane-server:0.9.0" + digest, BP_POSTGRES_IMAGE: "postgres:18.6" + digest,
  BP_RUSTFS_IMAGE: "rustfs/rustfs:1.0.0" + digest, BP_WORKERD_IMAGE: "ghcr.io/autonomiceng/agent-backplane-workerd:main-91de7da" + digest,
  BP_CADDY_IMAGE: "caddy:2.11.4" + digest,
};
const pools: Pool[] = [];
afterAll(async () => { await Promise.all(pools.splice(0).map(pool => pool.close({ timeout: 1 }))); });

describe("publicStatus", () => {
  test("emits exactly the contract 2 fields and nothing from the operations sample", () => {
    // Everything an operations document carries beyond the Checkpoint time must stay out.
    const sample = { backup: { completedAt: "2026-09-23T02:00:00Z", restorePoint: { name: "x", lsn: "0/1", timeline: 1 } },
      snapshot: { workspaceCount: "3" }, database: { systemId: "7" }, capabilities: {}, enrollment: { capabilityFile: "/data/enrollment/capability" }, telemetry: {} };
    const config = readStatusConfig({ ...images, BP_BACKUP_DIR: "/backups", BP_BLOB_BACKEND: "s3", BP_COMPUTE_URL: "http://workerd:8080", BP_CADDY_ENABLED: "true" }, "https://backplane.example.com");
    const document = JSON.parse(JSON.stringify(publicStatus(sample, config)));
    expect(Object.keys(document)).toEqual(["contract", "stack", "configuredAt", "components", "features"]);
    expect(document.contract).toBe(2);
    expect(document.stack).toBe("backplane");
    expect(document.configuredAt).toBe(config.configuredAt);
    expect(document.features).toEqual({ backups: { configured: true, lastCheckpointAt: "2026-09-23T02:00:00Z" } });
    expect(document.components.map((c: { id: string }) => c.id)).toEqual([...statusComponents]);
    for (const component of document.components) {
      expect(Object.keys(component)).toEqual(["id", "name", "kind", "enabled", "image", "version", "health", ...(component.id === "server" ? ["url"] : [])]);
      expect(component.health).toBe(`/health/${component.id}`);
      expect(component.image).not.toContain("@");
      expect(component.enabled).toBe(true);
    }
    expect(document.components[0]).toEqual({ id: "server", name: "Backplane", kind: "app", enabled: true, image: "ghcr.io/autonomiceng/agent-backplane-server:0.9.0",
      version: "0.9.0", health: "/health/server", url: "https://backplane.example.com" });
    expect(document.components.map((c: { version: string | null }) => c.version)).toEqual(["0.9.0", "18.6", "1.0.0", null, "2.11.4"]);
    expect(JSON.stringify(document)).not.toMatch(/sha256|capability|workspace|systemId|restorePoint|\/data/);
    expect(releaseVersion("server", "registry.example:5000/server:v1.2.3")).toBe("v1.2.3");
    expect(releaseVersion("postgres", "registry.example:5000/postgres")).toBeNull();
    expect(releaseVersion("postgres", "postgres:18.6-bookworm")).toBeNull();
    expect(releaseVersion("workerd", "ghcr.io/autonomiceng/agent-backplane-workerd:1.2.3")).toBe("1.2.3");
  });

  test("the frozen contract fixture is reproduced from its configuration", () => {
    const env = Object.fromEntries(fixture.components.map(c => [`BP_${c.id.toUpperCase()}_IMAGE`, c.image + digest]));
    const config = { ...readStatusConfig({ ...env, BP_BACKUP_DIR: "/backups" }, "https://backplane.example.com"), configuredAt: fixture.configuredAt };
    expect(JSON.parse(JSON.stringify(publicStatus({ backup: { completedAt: "2026-09-23T02:00:00Z" } }, config)))).toEqual(fixture);
  });

  test("optional components report disabled without their overlays and absent without a reference", () => {
    const core = publicStatus({ backup: null }, readStatusConfig({ ...images, BP_BACKUP_DIR: "/backups" }, "http://localhost:3000"));
    expect(core.components.map(c => [c.id, c.enabled])).toEqual([["server", true], ["postgres", true], ["rustfs", false], ["workerd", false], ["caddy", false]]);
    expect(core.features.backups).toEqual({ configured: true, lastCheckpointAt: null });
    const bare = publicStatus({ backup: null }, readStatusConfig({}, "http://localhost:3000"));
    expect(bare.components).toEqual([]);
    expect(bare.features.backups.configured).toBe(false);
  });
});

test("GET /status.json and the component health paths are public, uncached and status-only", async () => {
  const pool = createPool(await migratedDatabase());
  pools.push(pool);
  const status = readStatusConfig({ ...images, BP_BACKUP_DIR: "/nonexistent", BP_CADDY_ENABLED: "true" }, "http://localhost");
  const app = await testApp(pool, { status });
  const request = (path: string, method = "GET") => app.handle(new Request(`http://localhost${path}`, { method, headers: { authorization: "Bearer stray", cookie: "session=stray" } }));
  const response = await request("/status.json");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toStartWith("application/json");
  const document = await response.json();
  expect(document).toMatchObject({ contract: 2, stack: "backplane", configuredAt: status.configuredAt, features: { backups: { configured: true, lastCheckpointAt: null } } });
  expect(document.components).toHaveLength(5);
  const head = await request("/status.json", "HEAD");
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  const post = await request("/status.json", "POST");
  expect(post.status).toBe(405);
  expect(post.headers.get("allow")).toBe("GET, HEAD");
  expect(await post.text()).toBe("");
  for (const [path, expected] of [["/health/server", 200], ["/health/postgres", 200], ["/health/rustfs", 404], ["/health/workerd", 404], ["/health/caddy", 404]] as const) {
    const probe = await request(path);
    expect(probe.status, path).toBe(expected);
    expect(probe.headers.get("cache-control"), path).toBe("no-store");
    expect(await probe.text(), path).toBe("");
  }
  // Enabled optional components probe the capability sampler; an unhealthy sample is 503, never a body.
  const degraded = await testApp(pool, { status: readStatusConfig({ ...images, BP_BLOB_BACKEND: "s3", BP_COMPUTE_URL: "http://workerd:8080" }, "http://localhost") });
  const workerd = await degraded.handle(new Request("http://localhost/health/workerd"));
  expect(workerd.status).toBe(503);
  expect(await workerd.text()).toBe("");
  expect((await degraded.handle(new Request("http://localhost/health/rustfs"))).status).toBe(503);
  const rejecting = await testApp(pool, { status: readStatusConfig({ ...images, BP_COMPUTE_URL: "http://workerd:8080" }, "http://localhost"), capabilitySampler: () => Promise.reject(new Error("sampler_failed")) });
  const rejected = await rejecting.handle(new Request("http://localhost/health/workerd"));
  expect(rejected.status).toBe(503);
  expect(await rejected.text()).toBe("");
});
