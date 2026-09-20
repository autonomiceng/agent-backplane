import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepare, resolveRustfsConsole, type Runner } from "./prepare.ts";
import { resolveAccess } from "../compose/validate-edge.ts";

test("prepare launches root compose without the core profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-prepare-compose-"));
  const calls: string[][] = [];
  const runner: Runner = async args => {
    calls.push(args);
    if (args[0] === "context") return "unix:///var/run/docker.sock";
    if (args[0] === "volume") return "";
    if (args.some(arg => arg.includes("curl"))) return JSON.stringify({ enrollment: { state: "claimed" } });
    return "";
  };
  try {
    await prepare([
      "--env-file", join(directory, ".env"),
      "--backup-dir", directory,
      "--public-url", "http://localhost:3000",
      "--capability-file", join(directory, "capability"),
    ], {}, runner);
    const root = resolve(import.meta.dir, "../..");
    const up = calls.find(args => args.at(-2) === "up" && args.at(-1) === "--wait");
    expect(up).toBeDefined();
    expect(up).toContain("--project-directory");
    expect(up).toContain(root);
    expect(up).toContain(resolve(root, "compose.yaml"));
    expect(up).not.toContain("core");
    expect(await readFile(join(directory, ".env"), "utf8")).toContain("BP_ACCESS_MODE='local'");
    expect(await readFile(join(directory, ".env"), "utf8")).toContain("BP_PUBLIC_URL='http://localhost:3000'");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("prepare preserves complete image references and rejects ambiguous server assignments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-prepare-images-"));
  const path = join(directory, ".env");
  const images = `BP_SERVER_IMAGE=server-local:dev\nBP_POSTGRES_IMAGE=mirror/pg:experiment\nBP_CADDY_IMAGE=mirror/caddy@sha256:${"a".repeat(64)}\nBP_RUSTFS_IMAGE=rustfs-local\nBP_BLOB_BOOTSTRAP_IMAGE=\n`;
  const runner: Runner = async args => {
    if (args[0] === "context") return "unix:///var/run/docker.sock";
    if (args.includes("up")) {
      expect(args).toContain("--no-build");
      expect(args[args.indexOf("--env-file") + 1]).toBe(path);
      expect((await readFile(path, "utf8")).startsWith(images)).toBe(true);
    }
    return args.some(arg => arg.includes("curl")) ? JSON.stringify({ enrollment: { state: "claimed" } }) : "";
  };
  try {
    await Bun.write(path, images);
    const args = ["--env-file", path, "--backup-dir", directory, "--capability-file", join(directory, "capability"), "--profile", "blobs"];
    await prepare(args, {}, runner);
    const prepared = await readFile(path, "utf8");
    expect(prepared).toMatch(/^BP_BLOB_S3_SECRET_KEY=[a-f0-9]{40}$/m);
    expect(prepared).toMatch(/^BP_RUSTFS_ROOT_PASSWORD=[a-f0-9]{64}$/m);
    await prepare(args, {}, runner);
    expect(await readFile(path, "utf8")).toBe(prepared);
    const legacy = prepared.replace(/^BP_BLOB_S3_SECRET_KEY=.*$/m, `BP_BLOB_S3_SECRET_KEY=${"a".repeat(64)}`);
    await Bun.write(path, legacy);
    await prepare(args, {}, runner);
    expect(await readFile(path, "utf8")).toBe(legacy);
    await Bun.write(path, prepared + "BP_SERVER_IMAGE=other\n");
    await expect(prepare(args, {}, runner)).rejects.toMatchObject({ error: "env_repair_required" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("prepare refuses persisted internal image overrides before launch or env changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-prepare-override-"));
  const path = join(directory, ".env");
  let calls = 0;
  try {
    for (const assignment of ["BP_WORKERD_EFFECTIVE_IMAGE=other:local", "export BP_WORKERD_EFFECTIVE_IMAGE=other:local", " BP_WORKERD_EFFECTIVE_IMAGE=", "BP_WORKERD_EFFECTIVE_IMAGE=''"]) {
      const source = `BP_WORKERD_IMAGE=fixture:local\n${assignment}\n`;
      await Bun.write(path, source);
      await expect(prepare(["--env-file", path, "--capability-file", join(directory, "capability"), "--profile", "compute"], {}, async () => {
        calls++; return "";
      })).rejects.toMatchObject({ error: "workerd_effective_image_persisted" });
      expect(await readFile(path, "utf8")).toBe(source);
    }
    expect(calls).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("console requires an explicit blobs and ingress selection and preserves installed settings on rerun", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-prepare-console-")), path = join(directory, ".env");
  const source = "BP_RUSTFS_CONSOLE=true\nBP_RUSTFS_ROOT_USER=existing-root\nBP_RUSTFS_ROOT_PASSWORD=existing-password\nBP_BLOB_S3_ACCESS_KEY=existing-agent\nBP_BLOB_S3_SECRET_KEY=existing-secret\nBP_BLOB_S3_BUCKET=existing-bucket\nBP_BLOB_BACKEND=s3\n";
  const calls: string[][] = [];
  const runner: Runner = async args => {
    calls.push(args);
    if (args[0] === "context") return "unix:///var/run/docker.sock";
    return args.some(arg => arg.includes("curl")) ? JSON.stringify({ enrollment: { state: "claimed" } }) : "";
  };
  const args = ["--env-file", path, "--backup-dir", directory, "--capability-file", join(directory, "capability")];
  try {
    await Bun.write(path, source);
    for (const profiles of [[], ["blobs"], ["edge"]]) {
      await expect(prepare([...args, ...profiles.flatMap(p => ["--profile", p])], {}, runner)).rejects.toMatchObject({ error: "rustfs_console_requires_blobs_and_ingress" });
      expect(await readFile(path, "utf8")).toBe(source);
    }
    expect(calls).toEqual([]);
    const selected = [...args, "--profile", "blobs", "--profile", "edge"];
    await Bun.write(path, source.replace("BP_BLOB_BACKEND=s3", "BP_BLOB_BACKEND=filesystem"));
    await expect(prepare(selected, {}, runner)).rejects.toMatchObject({ error: "rustfs_console_storage_conflict" });
    expect(calls).toEqual([]);
    await Bun.write(path, source);
    expect(await prepare(selected, {}, runner)).toContain("RustFS console: https://rustfs.localhost/rustfs/console/");
    const prepared = await readFile(path, "utf8");
    expect(prepared.startsWith(source)).toBe(true);
    await prepare(selected, { BP_RUSTFS_CONSOLE: "false", BP_RUSTFS_ROOT_PASSWORD: "ignored-shell-secret" }, runner);
    expect(await readFile(path, "utf8")).toBe(prepared);
    await Bun.write(path, prepared.replace("BP_RUSTFS_CONSOLE=true", "BP_RUSTFS_CONSOLE=false"));
    expect(await prepare(selected, {}, runner)).not.toContain("RustFS console:");
    expect(calls.at(-1)).toContain("blobs");
    expect(calls.at(-1)).toContain("edge");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("console validates complete authorities, separate origins and literal operator/proxy policy", () => {
  const base = {
    BP_ACCESS_MODE: "proxy", BP_PUBLIC_URL: "https://darkforge.tail694fe2.ts.net:8449", BP_RUSTFS_CONSOLE: "true",
    BP_RUSTFS_URL: "https://darkforge.tail694fe2.ts.net:8450", BP_TRUSTED_PROXIES: "192.0.2.2/32 2001:db8::2/128",
    BP_RUSTFS_CONSOLE_ALLOW: "100.100.1.2/32 fd7a:115c:a1e0::1/128",
  };
  const resolveConsole = (overrides: Record<string, string> = {}) => {
    const env = { ...base, ...overrides };
    return resolveRustfsConsole(env, ["blobs", "gateway"], resolveAccess(env));
  };
  expect(resolveConsole()).toMatchObject({ authority: "darkforge.tail694fe2.ts.net:8450", urlHost: "darkforge.tail694fe2.ts.net" });
  expect(resolveConsole({ BP_RUSTFS_URL: "https://[2001:db8::3]:8450", BP_TRUSTED_PROXIES: "192.0.2.2 2001:db8::2" })).toMatchObject({ authority: "[2001:db8::3]:8450", urlHost: "2001:db8::3" });
  for (const [key, value, error] of [
    ["BP_RUSTFS_CONSOLE", "yes", "rustfs_console_invalid"],
    ["BP_RUSTFS_URL", "", "rustfs_url_required"],
    ["BP_RUSTFS_URL", base.BP_PUBLIC_URL, "rustfs_origin_conflict"],
    ["BP_RUSTFS_HOST", "darkforge.tail694fe2.ts.net", "rustfs_origin_conflict"],
    ["BP_RUSTFS_HOST", "backplane.localhost", "rustfs_origin_conflict"],
    ...["https://user:pass@example.com", "https://example.com/path", "https://example.com?", "https://example.com#", "https://example.com:0", "https://example.com:65536", "https://example.com ", "https://exa'mple.com", "https://example.com/{env.SECRET}", "http://example.com"].map(value => ["BP_RUSTFS_URL", value, "rustfs_url_invalid"]),
    ...["private_ranges", "172.16.0.0/12", "100.64.0.0/10", "fd7a:115c:a1e0::/48", "192.0.2.2/33", "edge", "192.0.2.2\n"].map(value => ["BP_TRUSTED_PROXIES", value, "trusted_proxies_invalid"]),
    ["BP_TRUSTED_PROXIES", "", "trusted_proxies_required"],
    ...["", "private_ranges", "0.0.0.0/0", "::/0", "100.100.1.2/33", "::/129", "{env.SECRET}"].map(value => ["BP_RUSTFS_CONSOLE_ALLOW", value, "operator_allow_invalid"]),
    ["BP_RUSTFS_HOST", "rustfs.example.com:443", "rustfs_host_invalid"],
  ]) {
    expect(() => resolveConsole({ [key!]: value! })).toThrow(error);
  }
  expect(() => resolveConsole({ BP_PUBLIC_URL: "https://example.com", BP_RUSTFS_URL: "https://EXAMPLE.COM:443/" })).toThrow("rustfs_origin_conflict");
});

test("preparation emits standalone domain and proxy authority routing without changing browser authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-console-routing-")), path = join(directory, ".env");
  const runner: Runner = async args => args[0] === "context" ? "unix:///var/run/docker.sock"
    : args.some(arg => arg.includes("curl")) ? JSON.stringify({ enrollment: { state: "claimed" } }) : "";
  const args = ["--env-file", path, "--backup-dir", directory, "--capability-file", join(directory, "capability"), "--profile", "blobs"];
  try {
    for (const mode of ["local", "public"]) {
      await Bun.write(path, `BP_ACCESS_MODE=${mode}\nBP_PUBLIC_DOMAIN=example.com\nBP_HTTPS_PORT=8443\nBP_RUSTFS_CONSOLE=true\n`);
      const output = await prepare([...args, "--profile", "edge"], {}, runner);
      expect(output).toContain("RustFS console: https://rustfs.example.com:8443/rustfs/console/");
      expect(output).toContain("bp bootstrap --url 'https://backplane.example.com:8443'");
      const prepared = await readFile(path, "utf8");
      expect(prepared).toContain("BP_RUSTFS_AUTHORITY='rustfs.example.com:8443'");
      expect(prepared).toContain("BP_RUSTFS_URL_HOST='rustfs.example.com'");
    }
    const settings = "BP_ACCESS_MODE=proxy\nBP_PUBLIC_URL=https://same.example:8449\nBP_AUTH_URL=https://same.example:8449\nBP_RUSTFS_CONSOLE=true\nBP_RUSTFS_URL=https://same.example:8450\nBP_TRUSTED_PROXIES='192.0.2.2/32'\n";
    await Bun.write(path, settings);
    const output = await prepare([...args, "--profile", "gateway"], {}, runner);
    expect(output).toContain("RustFS console: https://same.example:8450/rustfs/console/");
    expect(output).toContain("bp bootstrap --url 'https://same.example:8449'");
    const prepared = await readFile(path, "utf8");
    expect(prepared.startsWith(settings)).toBe(true);
    expect(prepared).toContain("BP_RUSTFS_AUTHORITY='same.example:8450'");
    await Bun.write(path, prepared.replace("BP_RUSTFS_URL=https://same.example:8450", "BP_RUSTFS_URL=https://same.example:8451"));
    await prepare([...args, "--profile", "gateway"], {}, runner);
    expect(await readFile(path, "utf8")).toContain("BP_RUSTFS_AUTHORITY='same.example:8451'");
    const access = resolveAccess({ BP_PUBLIC_DOMAIN: "example.com", BP_HTTPS_PORT: "8443" }, true);
    expect(() => resolveRustfsConsole({ BP_PUBLIC_DOMAIN: "example.com", BP_RUSTFS_URL: "https://elsewhere.example:8443", BP_HTTPS_PORT: "8443" }, ["edge"], access)).toThrow("rustfs_url_listener_conflict");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
