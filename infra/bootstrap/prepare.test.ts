import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepare, resolveRustfsConsole, statusRecorder, type Runner } from "./prepare.ts";
import { record as isRecord } from "../../packages/cli/runtime/http.ts";
import { resolveAccess } from "../compose/validate-edge.ts";
import { defaultWorkerdBinary } from "./workerd-image.ts";

const fakeRunner: Runner = async (args, env) => {
  if (args[0] === "context") return "unix:///var/run/docker.sock";
  if (args[0] === "info") return "amd64";
  if (args[0] === "image") return `sha256:${"a".repeat(64)} amd64`;
  if (args[0] === "run") {
    const entrypoint = args.indexOf("--entrypoint");
    expect(args[entrypoint + 2]).toBe(`sha256:${"a".repeat(64)}`);
    if (args[entrypoint + 1] === "sha256sum") return `${defaultWorkerdBinary}  /usr/bin/workerd\na83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c  /usr/bin/bun`;
    if (args[entrypoint + 1] === "/usr/bin/workerd" && args.at(-1) === "--version") return "workerd 2026-09-18";
    if (args[entrypoint + 1] === "/usr/bin/bun" && args.at(-1) === "--version") return "1.4.2";
    throw Error("unexpected executable probe");
  }
  if (args.includes("config")) {
    const environment = { BP_BLOB_BACKEND: env.COMPOSE_PROFILES?.split(",").includes("blobs") ? "s3" : "filesystem" };
    return JSON.stringify({ services: { server: { environment: { ...environment, BP_COMPUTE_URL: env.COMPOSE_PROFILES?.split(",").includes("compute") ? "http://workerd:8080" : "" } }, "storage-init": { environment } } });
  }
  if (args.some(arg => arg.includes("/health/operations"))) return JSON.stringify({ status: "degraded", capabilities: {
    files: { state: "healthy", backend: env.COMPOSE_PROFILES?.split(",").includes("blobs") ? "s3" : "filesystem", observedAt: new Date().toISOString() },
    functions: { state: "healthy", backend: "workerd", observedAt: new Date().toISOString() },
  } });
  return args.some(arg => arg.includes("curl")) ? JSON.stringify({ enrollment: { state: "claimed" } }) : "";
};

test("prepare launches minimal root compose without the core profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-prepare-compose-"));
  const calls: string[][] = [];
  const runner: Runner = async (args, env) => {
    calls.push(args);
    if (args[0] === "context") return "unix:///var/run/docker.sock";
    if (args[0] === "volume") return "";
    if (args.some(arg => arg.includes("/health/ready"))) return JSON.stringify({ enrollment: { state: "claimed" } });
    return fakeRunner(args, env);
  };
  try {
    await prepare([
      "--mode", "minimal", "--env-file", join(directory, ".env"),
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
  const runner: Runner = async (args, env) => {
    if (args[0] === "context") return "unix:///var/run/docker.sock";
    if (args.includes("up")) {
      expect(args).toContain("--no-build");
      expect(args[args.indexOf("--env-file") + 1]).toBe(path);
      expect((await readFile(path, "utf8")).startsWith(images)).toBe(true);
    }
    return fakeRunner(args, env);
  };
  try {
    await Bun.write(path, images);
    const args = ["--env-file", path, "--backup-dir", directory, "--capability-file", join(directory, "capability"), "--profile", "blobs", "--profile", "compute"];
    await prepare(args, {}, runner);
    const prepared = await readFile(path, "utf8");
    expect(prepared).toMatch(/^BP_BLOB_S3_SECRET_KEY='[a-f0-9]{40}'$/m);
    expect(prepared).toMatch(/^BP_RUSTFS_ROOT_PASSWORD='[a-f0-9]{64}'$/m);
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
  const runner: Runner = async (args, env) => {
    calls.push(args);
    return fakeRunner(args, env);
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
    expect(await prepare([...selected, "--confirm-existing-selection", "--compose-project", "agent-backplane"], {}, runner)).toContain("RustFS console: https://rustfs.localhost/rustfs/console/");
    const prepared = await readFile(path, "utf8");
    expect(prepared.startsWith(source.replace("BP_BLOB_BACKEND=s3", "BP_BLOB_BACKEND='s3'"))).toBe(true);
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
  const runner = fakeRunner;
  const args = ["--env-file", path, "--backup-dir", directory, "--capability-file", join(directory, "capability"), "--profile", "blobs", "--profile", "compute"];
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
    await Bun.write(path, "BP_ACCESS_MODE=local\nBP_RUSTFS_CONSOLE=true\nBP_RUSTFS_URL=http://rustfs.localhost\n");
    await expect(prepare([...args, "--profile", "edge"], {}, runner)).rejects.toThrow("rustfs_url_invalid");
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

test("prepare normalizes status state once, preserves secrets, creates safe modes, and rejects unsafe paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-prepare-status-"));
  const path = join(directory, ".env"), state = join(directory, "host state"), capability = join(directory, "capability");
  const runner: Runner = async (args, env) => {
    if (args[0] === "context") return "unix:///var/run/docker.sock";
    if (args[0] === "volume") return "";
    return fakeRunner(args, env);
  };
  const oldMask = process.umask(0o077);
  try {
    await mkdir(join(state, "status"), { recursive: true, mode: 0o750 });
    await chmod(join(state, "status"), 0o750);
    await writeFile(path, "UNMANAGED_SECRET=keep-me\nBP_STATUS_DIR='host state'\n");
    const args = ["--env-file", path, "--backup-dir", directory, "--capability-file", capability];
    await prepare(args, {}, runner);
    const first = await readFile(path, "utf8");
    await prepare(args, {}, runner);
    expect(await readFile(path, "utf8")).toBe(first);
    expect(first).toContain("UNMANAGED_SECRET=keep-me");
    expect(first.match(/^BP_STATUS_DIR=/gm)?.length).toBe(1);
    expect(first).toContain(`BP_STATUS_DIR='${state}'`);
    expect((await lstat(join(state, "console"))).mode & 0o777).toBe(0o755);
    expect((await lstat(join(state, "status"))).mode & 0o777).toBe(0o750);

    const unsafe = join(directory, "unsafe.env");
    await writeFile(unsafe, "BP_STATUS_DIR=/\n");
    await expect(prepare(["--env-file", unsafe, "--backup-dir", directory,
      "--capability-file", capability], {}, runner)).rejects.toMatchObject({ error: "unsafe_status_directory" });
    const linked = join(directory, "linked"), target = join(directory, "target");
    await mkdir(target);
    await symlink(target, linked);
    await writeFile(unsafe, `BP_STATUS_DIR=${linked}\n`);
    await expect(prepare(["--env-file", unsafe, "--backup-dir", directory,
      "--capability-file", capability], {}, runner)).rejects.toMatchObject({ error: "status_path_unavailable" });
  } finally { process.umask(oldMask); await rm(directory, { recursive: true, force: true }); }
});

test("status recorder exposes only stable diagnostics and reports a missing Python runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-status-recorder-"));
  const linked = join(directory, "linked"), target = join(directory, "target");
  try {
    await mkdir(target);
    await symlink(target, linked);
    await expect(statusRecorder(["--state-dir", linked, "--prepare"]))
      .rejects.toMatchObject({ error: "status_path_unavailable" });
    await expect(statusRecorder(["--state-dir", target, "--prepare"], ""))
      .rejects.toMatchObject({ error: "status_python_required" });
    const envFile = join(directory, ".env");
    await writeFile(envFile, "COMPOSE_PROJECT_NAME=recorded\n", { mode: 0o600 });
    await expect(statusRecorder(["--state-dir", target, "--checkout", directory, "--env-file", envFile,
      "--project-name", "other", "--started", "2026-09-20T12:00:00Z", "--state", "healthy"]))
      .rejects.toMatchObject({ error: "status_selection_mismatch" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("prepare records bootstrap unavailable before launch and healthy only after readiness custody", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-prepare-record-"));
  const path = join(directory, ".env"), capability = join(directory, "capability"), records: string[][] = [];
  const args = ["--mode", "minimal", "--env-file", path, "--backup-dir", directory, "--capability-file", capability];
  const record = async (recordArgs: string[]) => {
    if (recordArgs.at(-1) === "healthy") expect(await readFile(capability, "utf8")).toMatch(/^[a-f0-9]{64}\n$/);
    records.push(recordArgs);
  };
  const runner: Runner = async (composeArgs, env) => {
    if (composeArgs[0] === "context") return "unix:///var/run/docker.sock";
    if (composeArgs[0] === "volume") return "";
    if (composeArgs.some(arg => arg.includes("/health/ready"))) return JSON.stringify({ enrollment: { state: "pending" } });
    if (composeArgs.at(-1) === "/data/enrollment/capability") return `${"a".repeat(64)}\n`;
    return fakeRunner(composeArgs, env);
  };
  try {
    await prepare(args, {}, runner, record);
    expect(records.filter(call => call.includes("--state")).map(call => call.at(-1))).toEqual(["unavailable", "healthy"]);
    records.length = 0;
    await expect(prepare(args, {}, async composeArgs => {
      const result = await runner(composeArgs, {});
      if (composeArgs.includes("up")) throw new Error("launch failed");
      return result;
    }, record)).rejects.toThrow("launch failed");
    expect(records.filter(call => call.includes("--state")).map(call => call.at(-1))).toEqual(["unavailable"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function selectionFixture(check: (fixture: {
  directory: string; path: string; args: string[]; calls: string[][]; records: string[][];
  runner: Runner; record: (args: string[]) => Promise<void>;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "bp-selection-"));
  const calls: string[][] = [], records: string[][] = [];
  const path = join(directory, ".env");
  try {
    await check({ directory, path, calls, records,
      args: ["--env-file", path, "--backup-dir", directory, "--capability-file", join(directory, "capability")],
      runner: async (args, env) => { calls.push(args); return fakeRunner(args, env); },
      record: async args => { records.push(args); },
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const mutations = (calls: string[][]) => calls.filter(args => args.includes("create") || args.includes("up") || args[0] === "run");

test("fresh full and minimal save native Compose selections, including independently selected ingress", async () => {
  for (const mode of [undefined, "full", "minimal"]) for (const ingress of [undefined, "edge", "gateway"]) await selectionFixture(async ({ path, args, runner, record, calls }) => {
    await prepare([...args, ...(mode ? ["--mode", mode] : []), ...(ingress ? ["--profile", ingress] : []),
      ...(ingress === "gateway" ? ["--access-mode", "proxy", "--public-url", "https://example.test"] : [])], {}, runner, record);
    const profiles = [...(mode === "minimal" ? [] : ["blobs", "compute"]), ...(ingress ? [ingress] : [])];
    const saved = await readFile(path, "utf8"), root = resolve(import.meta.dir, "../..");
    expect(saved).toContain("COMPOSE_PROJECT_NAME='agent-backplane'");
    expect(saved).toContain(`COMPOSE_PROFILES='${profiles.join(",")}'`);
    expect(saved).not.toContain("BP_WORKERD_IMAGE=");
    expect(saved).toContain(`COMPOSE_FILE='${[join(root, "compose.yaml"), ...profiles.map(p => join(root, `compose.${p}.yaml`))].join(":")}'`);
    expect(saved).toContain(`BP_BLOB_BACKEND='${mode === "minimal" ? "filesystem" : "s3"}'`);
    expect(saved.includes("BP_COMPUTE_TOKEN=")).toBe(mode !== "minimal");
    expect(calls.some(call => call[0] === "build")).toBe(mode !== "minimal");
    expect(calls.some(call => call[0] === "run")).toBe(mode !== "minimal");
    expect(calls.findIndex(call => call.includes("config"))).toBeLessThan(calls.findIndex(call => call.includes("create")));
  });
  for (const source of [undefined, "# retain operator settings\nBP_WORKERD_IMAGE=\n"]) await selectionFixture(async ({ directory, path, args, runner, record, calls, records }) => {
    if (source !== undefined) await writeFile(path, source);
    await expect(prepare(args, {}, async (command, env) => {
      const result = await runner(command, env);
      if (command[0] === "build") throw Error("artifact build failed");
      return result;
    }, record)).rejects.toThrow("artifact build failed");
    expect(await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; })).toBe(source);
    expect(mutations(calls)).toEqual([]); expect(records).toEqual([]);
    expect(calls.findIndex(call => call.includes("config"))).toBeLessThan(calls.findIndex(call => call[0] === "build"));
    await expect(lstat(join(directory, "data"))).rejects.toMatchObject({ code: "ENOENT" });
    calls.length = 0;
    await prepare([...args, "--mode", "minimal", "--profile", ""], {}, runner, record);
    expect(await readFile(path, "utf8")).toContain("COMPOSE_PROFILES=''");
    expect(await readFile(path, "utf8")).toContain("BP_BLOB_BACKEND='filesystem'");
    expect(calls.some(call => call[0] === "build" || call[0] === "run")).toBe(false);
  });
});

test("complete full and minimal selections preserve project, files, secrets and settings on rerun", async () => {
  for (const mode of ["full", "minimal"]) await selectionFixture(async ({ path, args, runner, record, calls }) => {
    await writeFile(path, "BP_VOLUME_PREFIX=original\nBP_PLATFORM_NETWORK=shared\nBP_SERVER_IMAGE=local:experiment\nBP_WORKERD_IMAGE=local:workerd\n");
    await prepare([...args, "--mode", mode, "--compose-project", "original"], {}, runner, record);
    const saved = await readFile(path, "utf8");
    calls.length = 0;
    await prepare(args, {}, runner, record);
    await prepare([...args, "--mode", mode], {}, runner, record);
    expect(await readFile(path, "utf8")).toBe(saved);
    const up = calls.find(call => call.includes("up"));
    expect(up).toContain("original"); expect(up).toContain("--no-build");
    expect(up?.includes("compute")).toBe(mode === "full");
    expect(calls.some(call => call[0] === "build")).toBe(false);
    expect(calls.filter(call => call[0] === "volume" && call[1] === "create").every(call => call.at(-1)?.startsWith("original_"))).toBe(true);
    expect(calls.find(call => call[0] === "network" && call[1] === "inspect")?.at(-1)).toBe("shared");
  });
});

test("conflicting modes and shell selectors refuse before persisted or runtime mutation", async () => {
  for (const mode of ["full", "minimal"]) await selectionFixture(async ({ path, args, runner, record, calls, records }) => {
    await prepare([...args, "--mode", mode], {}, runner, record);
    const saved = await readFile(path, "utf8");
    calls.length = 0; records.length = 0;
    await expect(prepare([...args, "--mode", mode === "full" ? "minimal" : "full"], {}, runner, record))
      .rejects.toMatchObject({ error: "mode_conflict_requires_explicit_upgrade_or_migration" });
    expect(calls).toEqual([]); expect(records).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(saved);
  });
  await selectionFixture(async ({ path, args, runner, record, calls, records }) => {
    for (const env of [{ COMPOSE_PROFILES: "" }, { COMPOSE_PROFILES: "blobs" }, { COMPOSE_FILE: resolve(import.meta.dir, "../../compose.yaml") }]) {
      await expect(prepare(args, env, runner, record)).rejects.toMatchObject({ error: "selection_conflict" });
    }
    await expect(prepare([...args, "--mode", "minimal", "--profile", "compute"], {}, runner, record))
      .rejects.toMatchObject({ error: "mode_conflict_requires_explicit_upgrade_or_migration" });
    await expect(prepare([...args, "--profile", ""], {}, runner, record)).rejects.toMatchObject({ error: "invalid_arguments", exit: 1 });
    expect(await prepare(["--help"], {})).toContain("Fresh --profile '' requires --mode minimal");
    expect(calls).toEqual([]); expect(records).toEqual([]);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("selected capability failures cannot publish healthy bootstrap or enrollment success", async () => {
  for (const capability of ["files", "functions"]) for (const fault of ["unavailable", "unknown", "disabled", "wrong-backend", "stale", "missing", "invalid-json", "timeout", "unsupported"]) {
    await selectionFixture(async ({ directory, args, runner, record, records, calls }) => {
      let elapsed = 0, attempts = 0;
      await expect(prepare(args, {}, async (command, env, timeoutMs) => {
        const response = await runner(command, env);
        if (!command.some(arg => arg.includes("/health/operations"))) return response;
        attempts++;
        expect(timeoutMs).toBe(Math.min(10_000, 30_000 - elapsed));
        expect(command.at(-1)).toContain("--max-time 5");
        if (fault === "timeout") { elapsed += timeoutMs ?? 0; throw Error("deadline"); }
        if (fault === "invalid-json") return "invalid";
        const body: unknown = JSON.parse(response);
        if (!isRecord(body) || !isRecord(body.capabilities)) throw Error("invalid fixture");
        if (fault === "unsupported") { delete body.capabilities; return JSON.stringify(body); }
        const observation = body.capabilities[capability];
        if (!isRecord(observation)) throw Error("missing fixture capability");
        if (fault === "wrong-backend") observation.backend = "other";
        else if (fault === "stale") observation.observedAt = new Date(Date.now() - 60_000).toISOString();
        else if (fault === "missing") delete body.capabilities[capability];
        else observation.state = fault;
        return JSON.stringify(body);
      }, record, { now: () => elapsed, sleep: async ms => { elapsed += ms; } })).rejects.toMatchObject({
        error: fault === "unsupported" ? "operations_capabilities_unsupported" : "selected_capabilities_not_ready", exit: 2,
      });
      expect(attempts).toBe(fault === "unsupported" || fault === "invalid-json" ? 1 : fault === "timeout" ? 3 : 4);
      expect(elapsed).toBe(fault === "timeout" ? 30_000 : fault === "unsupported" || fault === "invalid-json" ? 0 : 3000);
      expect(calls.some(call => call.at(-1) === "/data/enrollment/capability")).toBe(false);
      await expect(lstat(join(directory, "capability"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(records.filter(call => call.includes("--state")).map(call => call.at(-1))).toEqual(["unavailable"]);
    });
  }
});

test("capability polling recovers transient unknown before exporting pending enrollment", async () => {
  await selectionFixture(async ({ directory, args, runner, record, records }) => {
    let attempts = 0, elapsed = 0;
    const sleeps: number[] = [];
    const output = await prepare(args, {}, async (command, env) => {
      const response = await runner(command, env);
      if (command.some(arg => arg.includes("/health/ready"))) return JSON.stringify({ enrollment: { state: "pending" } });
      if (command.some(arg => arg.includes("/health/operations"))) {
        attempts++;
        expect(records.some(call => call.at(-1) === "healthy")).toBe(false);
        await expect(lstat(join(directory, "capability"))).rejects.toMatchObject({ code: "ENOENT" });
        if (attempts < 3) return JSON.stringify({ capabilities: { files: { state: "unknown" }, functions: { state: "unknown" } } });
      }
      if (command.at(-1) === "/data/enrollment/capability") {
        expect(attempts).toBe(3);
        return `${"a".repeat(64)}\n`;
      }
      return response;
    }, record, { now: () => elapsed, sleep: async ms => { sleeps.push(ms); elapsed += ms; } });
    expect(sleeps).toEqual([1000, 1000]);
    expect(output).toContain("bp bootstrap");
    expect(await readFile(join(directory, "capability"), "utf8")).toBe(`${"a".repeat(64)}\n`);
    expect(records.filter(call => call.includes("--state")).map(call => call.at(-1))).toEqual(["unavailable", "healthy"]);
  });
});

test("incomplete existing selection requires original confirmation; failed inventory cannot establish fresh state", async () => {
  for (const evidence of ["secrets", "volume", "container", "network", "failed-inventory"]) await selectionFixture(async ({ path, args, runner, record, calls, records }) => {
    const source = evidence === "secrets" ? "BP_AUTH_SECRET=original\n" : "# untouched\n";
    await writeFile(path, source);
    const inventory: Runner = async (args, env) => {
      const result = await runner(args, env);
      if (evidence === "failed-inventory" && args[0] === "volume") throw Error("inventory unavailable");
      if (evidence === "volume" && args[0] === "volume") return "agent-backplane_postgres-data";
      if (evidence === "container" && args[0] === "ps") return "container-id";
      if (evidence === "network" && args[0] === "network") return "original_default";
      return result;
    };
    if (evidence === "failed-inventory") await expect(prepare(args, {}, inventory, record)).rejects.toThrow("inventory unavailable");
    else await expect(prepare(args, {}, inventory, record)).rejects.toMatchObject({ error: "existing_selection_confirmation_required" });
    expect(await readFile(path, "utf8")).toBe(source);
    expect(mutations(calls)).toEqual([]); expect(records).toEqual([]);
    if (evidence === "secrets") {
      await expect(prepare([...args, "--confirm-existing-selection"], {}, runner, record)).rejects.toMatchObject({ error: "invalid_arguments" });
      await prepare([...args, "--confirm-existing-selection", "--compose-project", "original", "--profile", ""], {}, runner, record);
      expect(await readFile(path, "utf8")).toContain("BP_AUTH_SECRET=original");
    } else if (evidence !== "failed-inventory") {
      await expect(prepare([...args, "--confirm-existing-selection", "--compose-project", "agent-backplane", "--profile", ""], {}, inventory, record))
        .rejects.toMatchObject({ error: "existing_volume_missing_secrets" });
      expect(mutations(calls)).toEqual([]); expect(records).toEqual([]);
    }
  });
  await selectionFixture(async ({ path, args, runner, record, calls, records }) => {
    const source = "BP_VOLUME_PREFIX=original\n" + ["BP_AUTH_SECRET", "BP_POSTGRES_ADMIN_PASSWORD", "BP_POSTGRES_PASSWORD", "BP_OPERATIONS_TOKEN",
      "BP_RUSTFS_ROOT_USER", "BP_RUSTFS_ROOT_PASSWORD", "BP_BLOB_S3_ACCESS_KEY", "BP_BLOB_S3_SECRET_KEY"].map(key => `${key}=retained\n`).join("");
    await writeFile(path, source);
    const inventory: Runner = async (args, env) => {
      const result = await runner(args, env);
      return args[0] === "volume" && args[1] === "ls" ? "original_rustfs-data\n" : result;
    };
    const confirmation = [...args, "--confirm-existing-selection", "--compose-project", "original", "--profile"];
    await expect(prepare([...confirmation, ""], {}, inventory, record)).rejects.toMatchObject({ error: "backend_change_requires_migration" });
    expect(await readFile(path, "utf8")).toBe(source);
    expect(mutations(calls)).toEqual([]); expect(records).toEqual([]);
    await expect(prepare([...confirmation, "blobs"], {}, async (args, env) => {
      const result = await inventory(args, env);
      return args.includes("config") ? await fakeRunner(args, { ...env, COMPOSE_PROFILES: "" }) : result;
    }, record)).rejects.toMatchObject({ error: "backend_change_requires_migration" });
    expect(await readFile(path, "utf8")).toBe(source);
    expect(mutations(calls)).toEqual([]); expect(records).toEqual([]);
    await prepare([...confirmation, "blobs"], {}, inventory, record);
    expect(await readFile(path, "utf8")).toContain(source);
    expect(await readFile(path, "utf8")).toContain("BP_BLOB_BACKEND='s3'");
  });
  const help = await prepare(["--help"], {}, async () => { throw Error("help must be local"); });
  expect(help).toContain("--confirm-existing-selection"); expect(help).toContain("'' selects none");
});

test("conflicting selectors, ambiguous assignments and backend changes refuse before mutations", async () => {
  await selectionFixture(async ({ path, args, runner, record, calls, records }) => {
    await expect(prepare([...args, "--profile", "edge", "--profile", "gateway"], {}, runner, record)).rejects.toMatchObject({ error: "choose_one_gateway" });
    const base = resolve(import.meta.dir, "../../compose.yaml"), overlay = resolve(import.meta.dir, "../../compose.blobs.yaml");
    await expect(prepare(args, { COMPOSE_PROJECT_NAME: "shell-project" }, runner, record)).rejects.toMatchObject({ error: "selection_conflict" });
    await expect(prepare(args, { COMPOSE_PROFILES: "blobs" }, runner, record)).rejects.toMatchObject({ error: "selection_conflict" });
    await expect(prepare(args, { COMPOSE_FILE: `${base}:${overlay}` }, runner, record)).rejects.toMatchObject({ error: "selection_conflict" });
    expect(calls).toEqual([]);
    expect(records).toEqual([]);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await prepare([...args, "--mode", "minimal"], { COMPOSE_PROJECT_NAME: "agent-backplane", COMPOSE_FILE: base, COMPOSE_PROFILES: "" }, runner, record);
    const saved = await readFile(path, "utf8");
    for (const flags of [["--compose-project", "other"], ["--profile", "blobs"], ["--profile", "edge", "--profile", "gateway"]]) {
      calls.length = 0; records.length = 0;
      await expect(prepare([...args, ...flags], {}, runner, record)).rejects.toThrow();
      expect(mutations(calls)).toEqual([]); expect(records).toEqual([]);
    }
    for (const env of [{ COMPOSE_PROJECT_NAME: "other" }, { COMPOSE_PROFILES: "blobs" }, { COMPOSE_FILE: "other.yaml" }]) {
      await expect(prepare(args, env, runner, record)).rejects.toMatchObject({ error: "selection_conflict" });
    }
    calls.length = 0;
    await expect(prepare(args, {}, async (args, env) => {
      const result = await runner(args, env);
      return args.includes("config") ? JSON.stringify({ services: { server: { environment: { BP_BLOB_BACKEND: "s3" } }, "storage-init": { environment: {} } } }) : result;
    }, record)).rejects.toMatchObject({ error: "backend_change_requires_migration" });
    expect(mutations(calls)).toEqual([]); expect(await readFile(path, "utf8")).toBe(saved);
    for (const duplicate of ["COMPOSE_PROFILES=\n", "BP_AUTH_SECRET=\n", "export COMPOSE_FILE=other\n", "COMPOSE_FILE=${FILES}\n"]) {
      await writeFile(path, saved + duplicate);
      await expect(prepare(args, {}, runner, record)).rejects.toMatchObject({ error: "env_repair_required" });
    }
  });
});

test("custom overlay order and meaningful empty profiles survive custom env directories", async () => {
  await selectionFixture(async ({ directory, path, args, runner, record, calls, records }) => {
    const base = resolve(import.meta.dir, "../../compose.yaml"), overlay = join(directory, "logging override.yaml"), last = join(directory, "last.yaml");
    await writeFile(overlay, "services: {}\n"); await writeFile(last, "services: {}\n");
    const unrelated = "# keep formatting\nOTHER=${KEEP}\nOTHER=second\n";
    await symlink(overlay, join(directory, "linked.yaml"));
    const linked = `${unrelated}COMPOSE_FILE='${base}:linked.yaml:last.yaml'\nCOMPOSE_PROFILES=\n`;
    await writeFile(path, linked);
    await expect(prepare(args, {}, runner, record)).rejects.toMatchObject({ error: "invalid_compose_file" });
    expect(await readFile(path, "utf8")).toBe(linked);
    expect(calls).toEqual([]); expect(records).toEqual([]);
    const rebased = `${unrelated}COMPOSE_FILE='logging override.yaml:${base}:last.yaml'\nCOMPOSE_PROFILES=\n`;
    await writeFile(path, rebased);
    await expect(prepare(args, {}, runner, record)).rejects.toMatchObject({ error: "invalid_compose_file" });
    expect(await readFile(path, "utf8")).toBe(rebased);
    expect(calls).toEqual([]); expect(records).toEqual([]);
    await writeFile(path, `${unrelated}COMPOSE_FILE='${base}:logging override.yaml:last.yaml'\nCOMPOSE_PROFILES=\n`);
    await prepare(args, {}, runner, record);
    const saved = await readFile(path, "utf8");
    expect(saved.startsWith(unrelated)).toBe(true);
    expect(saved).toContain(`COMPOSE_FILE='${base}:${overlay}:${last}'`);
    expect(saved).toContain("COMPOSE_PROFILES=''");
    calls.length = 0;
    await prepare([...args, "--profile", ""], {}, runner, record);
    expect(await readFile(path, "utf8")).toBe(saved);
    const up = calls.find(call => call.includes("up")) ?? [];
    expect(up.filter((_, i) => up[i - 1] === "-f")).toEqual([base, overlay, last]);
    expect(up).not.toContain("--profile");
  });
});

test("interruption after atomic env publication retains selection and identities on rerun", async () => {
  for (const boundary of ["network", "volume", "up"]) await selectionFixture(async ({ path, args, runner, record, calls }) => {
    let saved = "";
    await expect(prepare([...args, "--compose-project", "retained", "--profile", "blobs"], {}, async (args, env) => {
      const result = await runner(args, env);
      if (args[0] === "network" && args[1] === "inspect") throw Error("absent network");
      if (args.includes("create") && args[0] === boundary || args.includes(boundary) && boundary === "up") {
        saved = await readFile(path, "utf8");
        expect(saved).toContain("COMPOSE_PROJECT_NAME='retained'");
        expect(saved).toContain("COMPOSE_PROFILES='blobs,compute'");
        expect(saved).toMatch(/BP_AUTH_SECRET='[a-f0-9]{64}'/);
        throw Error("interrupted");
      }
      return result;
    }, record)).rejects.toThrow("interrupted");
    calls.length = 0;
    await prepare(args, {}, async (args, env) => {
      const result = await runner(args, env);
      return args[0] === "volume" && args[1] === "ls" ? "agent-backplane_postgres-data" : result;
    }, record);
    expect(await readFile(path, "utf8")).toBe(saved);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(calls.find(call => call.includes("up"))).toContain("retained");
  });
});
