// Three release scenarios cover filesystem custody, uncertain issuance and usable CLI/MCP credentials.
import { expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../../../apps/server/app.ts";
import { createPool } from "../../../apps/server/platform/pool.ts";
import { createAuth } from "../../../apps/server/auth/auth.ts";
import { createEnrollment } from "../../../apps/server/auth/enrollment.ts";
import { capabilityPath } from "../../../apps/server/auth/enrollment-file.ts";
import { latestMigrationVersion, migratedDatabase } from "../../../apps/server/testing/postgres.ts";
import { prepare, type Runner } from "../../../infra/bootstrap/prepare.ts";
import { execute, type Execution } from "./execute.ts";
import { credentialEnvironment, privateRead, privateWrite } from "./credential-file.ts";
import { catalog } from "../../mcp/runtime/tools.ts";

async function fixture(socket = false) {
  const directory = await mkdtemp(join(tmpdir(), "bp-bootstrap-"));
  let pool: ReturnType<typeof createPool> | undefined;
  let listener: Bun.Server<undefined> | undefined;
  const close = async () => {
    const stopped = await Promise.allSettled([Promise.resolve().then(() => listener?.stop(true)), Promise.resolve().then(() => pool?.close())]);
    const removed = await Promise.allSettled([rm(directory, { recursive: true, force: true })]);
    const failure = [...stopped, ...removed].find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  };
  try {
    pool = createPool(await migratedDatabase());
    listener = socket ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 503 }) }) : undefined;
    const origin = listener ? `http://localhost:${listener.port}` : "http://localhost";
    const config = { publicOrigin: origin, authSecret: "bootstrap-test-secret-longer-than-thirty-two", signup: "closed", dataDir: join(directory, "server") } as const;
    const enrollment = createEnrollment(pool, config); await enrollment.prepare();
    const app = createApp({ pool, enrollment, authUrl: origin, auth: createAuth(pool, config), expectedSchemaVersion: await latestMigrationVersion() });
    listener?.reload({ fetch: request => app.handle(request) });
    const transport = socket ? fetch : Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => app.handle(new Request(String(url), init)), { preconnect: fetch.preconnect });
    const env = { BP_URL: origin, BP_USER_EMAIL: "first@example.com", BP_BOOTSTRAP_PASSWORD: "bootstrap-test-password", BP_DATA_DIR: join(directory, "client") };
    const argv = ["bootstrap", "--capability-file", capabilityPath(config.dataDir)];
    const call = async (args = argv, overrides: Partial<Execution> = {}) => {
      let stdout = "", stderr = "";
      const code = await execute(args, { env, stdin: async () => "", transport, stdout: value => { stdout += value; }, stderr: value => { stderr += value; }, ...overrides });
      return { code, stdout, stderr };
    };
    const checkpoint = async () => {
      const root = join(env.BP_DATA_DIR, "cli/bootstrap"), file = (await readdir(root)).find(name => name.endsWith(".json") && !name.endsWith(".credentials.json"));
      if (!file) throw new Error("checkpoint missing");
      return { path: join(root, file), value: JSON.parse(await readFile(join(root, file), "utf8")) };
    };
    return { directory, pool, app, env, argv, origin, call, checkpoint, transport, enrollment, close };
  } catch (error) { await close().catch(() => {}); throw error; }
}

test("rerun overwrites secrets or repeats provisioning after an interrupted creation", async () => {
  const f = await fixture();
  try {
    const envPath = join(f.directory, ".env"), capability = join(f.directory, "capability"), secret = "a".repeat(64);
    let existingVolume = false;
    const verifierContainers = new Map<string, string[]>();
    const runner: Runner = async (args, env) => {
      if (args[0] === "create") { verifierContainers.set("a".repeat(64), args); return "a".repeat(64); }
      if (args[0] === "rm") { verifierContainers.delete(args.at(-1) ?? ""); return ""; }
      if (args[0] === "start") args = verifierContainers.get(args.at(-1) ?? "") ?? [];
      return args.includes("config") ? JSON.stringify({ services: {
      server: { environment: { BP_BLOB_BACKEND: env.COMPOSE_PROFILES?.split(",").includes("blobs") ? "s3" : "filesystem" } },
      "storage-init": { environment: { BP_BLOB_BACKEND: env.COMPOSE_PROFILES?.split(",").includes("blobs") ? "s3" : "filesystem" } },
    } }) : args[0] === "image" ? `sha256:${"e".repeat(64)} amd64` : args[0] === "create" ? args.at(-1) === "--version" ? args.includes("/usr/bin/bun") ? "1.4.2" : "workerd 2026-09-18" : `${"d".repeat(64)}  /usr/bin/workerd\na83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c  /usr/bin/bun` : args[0] === "context" ? "unix:///var/run/docker.sock" : args[0] === "volume" ? existingVolume ? "existing-data" : "" : args.at(-1) === "/data/enrollment/capability" ? secret : args.some(arg => arg.includes("curl")) ? JSON.stringify({ enrollment: { state: "pending" } }) : "";
    };
    const args = ["--env-file", envPath, "--backup-dir", f.directory, "--public-url", "http://localhost:3000", "--capability-file", capability];
    const unrelated = 'UNRELATED=${KEEP_THIS}\nUNRELATED=again\nOTHER=`untouched`\nBP_CUSTOM=${UNMANAGED}\n';
    await privateWrite(envPath, unrelated);
    const next = await prepare(args, {}, runner); expect(next).not.toContain("--compose-project");
    const first = await readFile(envPath, "utf8"); existingVolume = true;
    expect(first.startsWith(unrelated)).toBe(true);
    const unsafeParent = await mkdtemp(join(f.directory, "unsafe-parent-")); await chmod(unsafeParent, 0o770);
    await expect(privateWrite(join(unsafeParent, "credential.json"), "secret")).rejects.toMatchObject({ error: "unsafe_private_directory" });
    await expect(prepare([...args, "--env-file", join(unsafeParent, ".env")], {}, runner)).rejects.toMatchObject({ error: "unsafe_private_directory" });
    await chmod(unsafeParent, 0o700);
    await prepare(args, {}, runner); expect(await readFile(envPath, "utf8")).toBe(first);
    expect((await stat(envPath)).mode & 0o777).toBe(0o600); expect((await stat(capability)).mode & 0o777).toBe(0o600);
    await chmod(envPath, 0o644); await prepare(args, {}, runner); expect((await stat(envPath)).mode & 0o777).toBe(0o600);
    expect(first).not.toContain("BP_COMPUTE_TOKEN"); expect(first).not.toContain("BP_RUSTFS_ROOT_PASSWORD");
    await writeFile(envPath, first.replace(/^BP_AUTH_SECRET=.*\n/m, ""));
    await expect(prepare(args, {}, runner)).rejects.toMatchObject({ error: "existing_volume_missing_secrets" });
    await writeFile(envPath, first);
    const hardlink = join(f.directory, "linked"); await link(envPath, hardlink);
    await expect(prepare(args, {}, runner)).rejects.toMatchObject({ error: "unsafe_private_file" }); await rm(hardlink);
    const symbolic = join(f.directory, "symbolic"); await symlink(envPath, symbolic);
    await expect(prepare(["--env-file", symbolic, "--capability-file", capability], {}, runner)).rejects.toMatchObject({ error: "unsafe_private_file" });
    const profilesPath = join(f.directory, "profiles.env"); existingVolume = false;
    await privateWrite(profilesPath, `BP_RUSTFS_IMAGE=rustfs@sha256:${"b".repeat(64)}\nBP_BLOB_BOOTSTRAP_IMAGE=server@sha256:${"c".repeat(64)}\nBP_WORKERD_IMAGE=workerd:local\nBP_WORKERD_BINARY_SHA256=${"d".repeat(64)}\n`);
    await prepare([...args, "--env-file", profilesPath, "--profile", "blobs", "--profile", "compute"], {}, runner);
    const profiles = await readFile(profilesPath, "utf8");
    expect(profiles).toMatch(/^BP_COMPUTE_TOKEN='[a-f0-9]{64}'$/m);
    expect(profiles).toMatch(/^BP_RUSTFS_ROOT_USER='[a-f0-9]{20}'$/m);
    expect(profiles).toMatch(/^BP_BLOB_S3_ACCESS_KEY='[a-f0-9]{20}'$/m);
    expect(profiles).toMatch(/^BP_RUSTFS_ROOT_PASSWORD='[a-f0-9]{64}'$/m);
    expect(profiles).toMatch(/^BP_BLOB_S3_SECRET_KEY='[a-f0-9]{40}'$/m);
    await prepare([...args, "--env-file", profilesPath, "--profile", "blobs", "--profile", "compute"], {}, runner);
    expect(await readFile(profilesPath, "utf8")).toBe(profiles);
    expect((await f.call([...f.argv, "--principal-id", "invalid"])).code).toBe(1);
    expect(await f.pool<{ count: number }[]>`SELECT count(*)::int AS count FROM control."user"`).toEqual([{ count: 0 }]);
    let lost = false;
    const discard = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await f.transport(url, init);
      if (String(url).endsWith("/principals") && init?.method === "POST" && !lost) { lost = true; throw new Error("lost creation response"); }
      return response;
    }, { preconnect: fetch.preconnect });
    expect((await f.call(f.argv, { transport: discard })).code).toBe(2);
    expect((await f.call()).code).toBe(2);
    const [principal] = await f.pool<{ id: string; workspace_id: string }[]>`SELECT id, workspace_id FROM control.principals WHERE system IS NULL`;
    if (!principal) throw new Error("created Principal missing");
    const adopted = await f.call([...f.argv, "--principal-id", principal.id.toUpperCase()]); expect(adopted.code).toBe(0);
    const result = JSON.parse(adopted.stdout), saved = await readFile(result.credentialsFile, "utf8");
    expect((await f.call()).stdout).toBe(adopted.stdout);
    expect(await readFile(result.credentialsFile, "utf8")).toBe(saved);
    expect(await f.pool<{ count: number }[]>`SELECT count(*)::int AS count FROM control.principals WHERE system IS NULL`).toEqual([{ count: 1 }]);
    expect(await f.pool<{ count: number }[]>`SELECT count(*)::int AS count FROM control.workspaces`).toEqual([{ count: 1 }]);
    expect(await f.pool<{ count: number }[]>`SELECT count(*)::int AS count FROM control."user"`).toEqual([{ count: 1 }]);
    expect(await f.pool<{ count: number }[]>`SELECT count(*)::int AS count FROM control.enrollment`).toEqual([{ count: 1 }]);
    const key = JSON.parse(saved).key;
    expect(await f.pool<{ prefix: string }[]>`SELECT prefix FROM control.principal_keys`).toEqual([{ prefix: key.split("_")[1] }]);
    const checkpoint = await f.checkpoint();
    expect(checkpoint.value.step).toBe("key:saved");
    expect(checkpoint.value).toMatchObject({ step: "key:saved", userId: expect.any(String), workspaceId: result.workspaceId, principalId: result.principalId, credentialFile: result.credentialsFile });
    expect(await readFile(checkpoint.path, "utf8")).not.toContain(key);
    expect(checkpoint.value.credentialFile).toBe(result.credentialsFile);
  } finally { await f.close(); }
}, 30_000);

test("lost issuance acknowledgement silently rotates instead of retaining ambiguity", async () => {
  const f = await fixture();
  try {
    const refused = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(url).endsWith("/keys") && init?.method === "POST") throw Object.assign(new Error("connection refused before sending"), { code: "ECONNREFUSED" });
      return f.transport(url, init);
    }, { preconnect: fetch.preconnect });
    expect((await f.call(f.argv, { transport: refused })).code).toBe(2);
    expect((await f.checkpoint()).value.step).toBe("principal:saved");
    expect((await f.checkpoint()).value).not.toHaveProperty("credentialFile");
    expect(await f.pool<{ count: number }[]>`SELECT count(*)::int AS count FROM control.principal_keys`).toEqual([{ count: 0 }]);
    const discard = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await f.transport(url, init);
      if (String(url).endsWith("/keys") && init?.method === "POST") { expect(response.status).toBe(201); throw new Error("acknowledgement lost after commit"); }
      return response;
    }, { preconnect: fetch.preconnect });
    const lost = await f.call(f.argv, { transport: discard }); expect(lost.code).toBe(3);
    const before = await f.pool`SELECT prefix, created_at, rotated_at FROM control.principal_keys`;
    expect(before).toHaveLength(1);
    expect((await f.checkpoint()).value.step).toBe("key:ambiguous");
    expect((await f.checkpoint()).value).toMatchObject({ step: "key:ambiguous", userId: expect.any(String), workspaceId: expect.any(String), principalId: expect.any(String), credentialFile: expect.any(String) });
    expect(lost.stderr).toContain("--credential-out NEW_PRIVATE_FILE");
    expect((await f.call()).code).toBe(3);
    expect(await f.pool`SELECT prefix, created_at, rotated_at FROM control.principal_keys`).toEqual(before);
    const state = (await f.checkpoint()).value, recovery = join(f.directory, "recovery.json");
    const issue = ["auth", "issue-principal-key", "--workspace-id", state.workspaceId.toUpperCase(), "--principal-id", state.principalId.toUpperCase(), "--credential-out", recovery];
    expect((await f.call([...issue, "--principal-id", "invalid"])).code).toBe(1);
    expect(await f.pool`SELECT prefix, created_at, rotated_at FROM control.principal_keys`).toEqual(before);
    const explicit = await f.call(issue); expect(explicit.code).toBe(0);
    const key = JSON.parse(await readFile(recovery, "utf8")).key;
    expect(explicit.stdout).not.toContain(key); expect(explicit.stdout).toContain("[REDACTED]");
    const recovered = await f.call([...f.argv, "--recover-key-file", recovery]); expect(recovered.code).toBe(0);
    expect((await f.call()).stdout).toBe(recovered.stdout);
    const rotated = await f.pool`SELECT prefix, created_at, rotated_at FROM control.principal_keys`;
    expect(rotated[0].prefix).not.toBe(before[0].prefix);
    expect((await f.call(issue)).code).toBe(1);
    expect(await f.pool`SELECT prefix, created_at, rotated_at FROM control.principal_keys`).toEqual(rotated);
    expect((await stat(recovery)).mode & 0o777).toBe(0o600);
    const checkpoint = await f.checkpoint();
    await privateWrite(checkpoint.path, JSON.stringify({ ...checkpoint.value, step: "key:in-flight" }), true);
    expect((await f.call()).code).toBe(0);
    expect((await f.checkpoint()).value.step).toBe("key:saved");
    expect((await f.checkpoint()).value).toEqual({ ...checkpoint.value, step: "key:saved" });
    expect(checkpoint.value).toMatchObject({ userId: state.userId, workspaceId: state.workspaceId, principalId: state.principalId, credentialFile: JSON.parse(recovered.stdout).credentialsFile });
    expect(await f.pool`SELECT prefix, created_at, rotated_at FROM control.principal_keys`).toEqual(rotated);
    expect(await readFile(checkpoint.path, "utf8")).not.toContain(key);
    const failedDirectory = await mkdtemp(join(f.directory, "failed-delivery-")), failedFile = join(failedDirectory, "key.json");
    const failPersistence = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await f.transport(url, init);
      if (String(url).endsWith("/keys") && init?.method === "POST") { expect(response.status).toBe(201); await chmod(failedDirectory, 0o770); }
      return response;
    }, { preconnect: fetch.preconnect });
    const failed = await f.call([...issue, "--credential-out", failedFile], { transport: failPersistence });
    expect(failed.code).toBe(3); expect(failed.stderr).toContain("key_ambiguous");
    await chmod(failedDirectory, 0o700);
    const afterFailure = await f.pool`SELECT prefix, created_at, rotated_at FROM control.principal_keys`;
    expect(afterFailure[0].prefix).not.toBe(rotated[0].prefix);
    expect((await f.call([...issue, "--credential-out", failedFile])).code).toBe(1);
    expect(await f.pool`SELECT prefix, created_at, rotated_at FROM control.principal_keys`).toEqual(afterFailure);
  } finally { await f.close(); }
}, 30_000);

test("saved credentials cannot operate CLI or the MCP child over real HTTP", async () => {
  const f = await fixture(true);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const result = await f.call(); expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout), saved = JSON.parse(await readFile(output.credentialsFile, "utf8"));
    const cli = await f.call(["auth", "whoami"], { env: { BP_CREDENTIALS_FILE: output.credentialsFile, BP_DATA_DIR: f.env.BP_DATA_DIR } });
    expect(cli.code).toBe(0); expect(JSON.parse(cli.stdout)).toEqual({ workspaceId: saved.workspaceId, principalId: saved.principalId });
    const events = await f.pool<{ user_id: string; kind: string }[]>`SELECT user_id, kind FROM audit.events WHERE workspace_id = ${saved.workspaceId} ORDER BY position`;
    expect(events.length).toBeGreaterThanOrEqual(3);
    const checkpoint = await f.checkpoint();
    expect(events.every(event => event.user_id === checkpoint.value.userId)).toBe(true);
    expect((await stat(checkpoint.path)).mode & 0o777).toBe(0o600);
    expect((await stat(output.credentialsFile)).mode & 0o777).toBe(0o600);
    expect(result.stdout + result.stderr).not.toContain(saved.key);
    expect(result.stdout + result.stderr).not.toContain(f.env.BP_BOOTSTRAP_PASSWORD);
    const config = output.mcpServers.backplane;
    expect(config.command).toBe("bp");
    child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), ...config.args], {
      env: { PATH: process.env.PATH, ...config.env, BP_DATA_DIR: f.env.BP_DATA_DIR }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const capturedPid = child.pid; expect(capturedPid).toBeGreaterThan(0);
    if (!child.stdin || typeof child.stdin === "number") throw new Error("missing MCP stdin");
    const tool = catalog.find(tool => tool.command.operationId === "whoami");
    if (!tool) throw new Error("whoami tool missing");
    child.stdin.write([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bootstrap-test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool.name, arguments: { workspaceId: saved.workspaceId } } },
    ].map(value => JSON.stringify(value) + "\n").join(""));
    if (!child.stdout || typeof child.stdout === "number" || !child.stderr || typeof child.stderr === "number") throw new Error("missing MCP pipes");
    const timer = setTimeout(() => child?.kill(), 10_000), reader = child.stdout.getReader();
    let stdout = "";
    const errors = new Response(child.stderr).text();
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        stdout += new TextDecoder().decode(part.value);
        if (stdout.split("\n").slice(0, -1).some(line => JSON.parse(line).id === 2)) { child.stdin.end(); break; }
      }
      while (!(await reader.read()).done) { /* Drain shutdown after the complete tool response. */ }
    } finally { clearTimeout(timer); reader.releaseLock(); }
    const stderr = await errors;
    expect(await child.exited).toBe(0); expect(stderr).toBe("");
    const reply = stdout.trim().split("\n").map(line => JSON.parse(line)).find(value => value.id === 2);
    expect(reply.result.isError).toBe(false);
    expect(JSON.parse(reply.result.content[0].text)).toEqual({ workspaceId: saved.workspaceId, principalId: saved.principalId });
    expect(stdout).not.toContain(saved.key);
    await expect(credentialEnvironment({ BP_CREDENTIALS_FILE: output.credentialsFile, BP_KEY: "conflicting" })).rejects.toMatchObject({ error: "credential_environment_conflict" });
    const extra = join(f.directory, "extra.json"); await privateWrite(extra, JSON.stringify({ ...saved, BP_ADMIN_DATABASE_URL: "forbidden" }));
    await expect(credentialEnvironment({ BP_CREDENTIALS_FILE: extra })).rejects.toMatchObject({ error: "credential_file_invalid" });
    const malformed = join(f.directory, "malformed.json"); await privateWrite(malformed, "{broken");
    await expect(credentialEnvironment({ BP_CREDENTIALS_FILE: malformed })).rejects.toMatchObject({ error: "credential_file_invalid" });
    await chmod(output.credentialsFile, 0o644);
    await expect(privateRead(output.credentialsFile)).rejects.toMatchObject({ error: "unsafe_private_file" });
  } finally { if (child && child.exitCode === null) { child.kill(); await child.exited; } await f.close(); }
}, 30_000);


test("bootstrap accepts the configured public URL and an equivalent auth origin", async () => {
  const f = await fixture();
  try {
    const result = await f.call(f.argv, { env: { ...f.env, BP_URL: undefined,
      BP_PUBLIC_URL: f.origin, BP_AUTH_URL: f.origin.toUpperCase() + "/" } });
    expect(result.code, result.stderr).toBe(0);
  } finally { await f.close(); }
});
