import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
async function config(settings: string[] = [], overlays = ["edge"]) {
  const directory = await mkdtemp(join(tmpdir(), "bp-images-"));
  try {
    const path = join(directory, ".env");
    await Bun.write(path, ["BP_BACKUP_DIR=/tmp/unused", "BP_AUTH_SECRET=fixture", "BP_POSTGRES_ADMIN_PASSWORD=fixture",
      "BP_POSTGRES_PASSWORD=fixture", "BP_PUBLIC_URL=http://localhost:3000", "BP_RUSTFS_ROOT_USER=fixture",
      "BP_RUSTFS_ROOT_PASSWORD=fixture", "BP_BLOB_S3_ACCESS_KEY=fixture", "BP_BLOB_S3_SECRET_KEY=fixture", ...settings].join("\n"));
    const child = Bun.spawn(["docker", "compose", "--env-file", path, "-f", join(root, "compose.yaml"),
      ...overlays.flatMap(name => ["-f", join(root, `compose.${name}.yaml`)]), "--profile", "*", "config", "--format", "json"], {
      env: Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith("BP_") && !key.startsWith("COMPOSE_"))),
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out).services;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Three real Compose processes need startup time on shared CI runners.
test("native image defaults survive empty settings and accept complete references", async () => {
  const defaults = await config();
  expect(defaults.postgres.image).toMatch(/^postgres:18\.6@sha256:[a-f0-9]{64}$/);
  expect(defaults.edge.image).toMatch(/^caddy:2\.11\.4@sha256:[a-f0-9]{64}$/);
  expect(defaults.server.image).toMatch(/^ghcr\.io\/autonomiceng\/agent-backplane-server:[\w.-]+@sha256:[a-f0-9]{64}$/);
  const empty = await config(["BP_POSTGRES_IMAGE=", "BP_SERVER_IMAGE=", "BP_CADDY_IMAGE="]);
  expect(empty).toEqual(defaults);
  const override = await config(["BP_POSTGRES_IMAGE=registry.example:5000/postgres:experiment", "BP_SERVER_IMAGE=local-server:dev",
    `BP_CADDY_IMAGE=mirror/caddy@sha256:${"b".repeat(64)}`]);
  expect(override.postgres.image).toBe("registry.example:5000/postgres:experiment");
  expect(override.server.image).toBe("local-server:dev");
  expect(override.edge.image).toBe(`mirror/caddy@sha256:${"b".repeat(64)}`);
}, 15000);

test("helpers inherit server and PostgreSQL references including the internal gateway", async () => {
  const services = await config(["BP_POSTGRES_IMAGE=pg-local", "BP_SERVER_IMAGE=server-local", "BP_CADDY_IMAGE=caddy-local"], ["gateway", "blobs"]);
  expect(services["backup-init"].image).toBe(services.postgres.image);
  for (const name of ["migrate", "data-init", "storage-init", "blob-bootstrap", "blob-image-check"]) expect(services[name].image).toBe(services.server.image);
  expect(services.edge.image).toBe("caddy-local");
  expect(services["blob-bootstrap"].environment.BP_BLOB_BOOTSTRAP_IMAGE).toBe("server-local");
});

test("blob declarations follow overrides and compute separates image reference from binary identity", async () => {
  const defaults = await config(["BP_RUSTFS_IMAGE=", "BP_BLOB_BOOTSTRAP_IMAGE="], ["blobs"]);
  expect(defaults.rustfs.image).toMatch(/^rustfs\/rustfs:1\.0\.0@sha256:[a-f0-9]{64}$/);
  expect(defaults["blob-bootstrap"].environment.BP_RUSTFS_IMAGE).toBe(defaults.rustfs.image);
  const services = await config(["BP_RUSTFS_IMAGE=rustfs-local", "BP_BLOB_BOOTSTRAP_IMAGE=helper-experiment", "BP_WORKERD_IMAGE=workerd-local",
    `BP_WORKERD_BINARY_SHA256=${"c".repeat(64)}`, "BP_COMPUTE_TOKEN=fixture"], ["blobs", "compute"]);
  expect(services.rustfs.image).toBe("rustfs-local");
  expect(services["blob-bootstrap"].environment.BP_RUSTFS_IMAGE).toBe("rustfs-local");
  expect(services["blob-bootstrap"].image).toBe("helper-experiment");
  expect(services["blob-image-check"].image).toBe("helper-experiment");
  expect(services.workerd.image).toBe("workerd-local");
  expect(services.server.environment.BP_WORKERD_RUNTIME_ID).toBe(`workerd-binary-sha256:${"c".repeat(64)}`);
  expect(services.workerd.pull_policy).toBeUndefined();
});
