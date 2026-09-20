import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepare, type Runner } from "./prepare.ts";

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

test("prepare normalizes status state once, preserves secrets, creates safe modes, and rejects unsafe paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-prepare-status-"));
  const path = join(directory, ".env"), state = join(directory, "host state"), capability = join(directory, "capability");
  const runner: Runner = async args => {
    if (args[0] === "context") return "unix:///var/run/docker.sock";
    if (args[0] === "volume") return "";
    return args.some(arg => arg.includes("curl")) ? JSON.stringify({ enrollment: { state: "claimed" } }) : "";
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
      "--capability-file", capability], {}, runner)).rejects.toMatchObject({ error: "status_record_failed" });
  } finally { process.umask(oldMask); await rm(directory, { recursive: true, force: true }); }
});

test("prepare records bootstrap unavailable before launch and healthy only after readiness custody", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-prepare-record-"));
  const path = join(directory, ".env"), capability = join(directory, "capability"), records: string[][] = [];
  const args = ["--env-file", path, "--backup-dir", directory, "--capability-file", capability];
  const record = async (recordArgs: string[]) => {
    if (recordArgs.at(-1) === "healthy") expect(await readFile(capability, "utf8")).toMatch(/^[a-f0-9]{64}\n$/);
    records.push(recordArgs);
  };
  const runner: Runner = async composeArgs => {
    if (composeArgs[0] === "context") return "unix:///var/run/docker.sock";
    if (composeArgs[0] === "volume") return "";
    if (composeArgs.some(arg => arg.includes("curl"))) return JSON.stringify({ enrollment: { state: "pending" } });
    if (composeArgs.at(-1) === "/data/enrollment/capability") return `${"a".repeat(64)}\n`;
    return "";
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
