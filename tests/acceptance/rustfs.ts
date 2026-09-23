// Orchestrator-run Compose acceptance: three real RustFS/PostgreSQL scenarios, no embedded cluster.
import { strict as assert } from "node:assert";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { S3Client } from "bun";
import { fixture, uploaded } from "../../apps/server/blobs/testing/blob-fixture.ts";
import { s3Store } from "../../apps/server/blobs/s3-store.ts";
import { blobHash } from "../../apps/server/blobs/blob-store.ts";
import { cleanupBlobs } from "../../apps/server/blobs/sweep-blobs.ts";
import { createPool } from "../../apps/server/platform/pool.ts";
import { testApp } from "../../apps/server/testing/session.ts";

const required = (name: string) => { const value = Bun.env[name]; assert(value, `${name} is required`); return value; };
const bucket = () => required("BP_BLOB_S3_BUCKET");
const rootPair = () => [required("BP_RUSTFS_ROOT_USER"), required("BP_RUSTFS_ROOT_PASSWORD")] as const;
const scopedPair = () => [required("BP_BLOB_S3_ACCESS_KEY"), required("BP_BLOB_S3_SECRET_KEY")] as const;
const options = (endpoint = "http://rustfs:9000") => ({ endpoint, bucket: bucket(), region: "us-east-1",
  accessKeyId: scopedPair()[0], secretAccessKey: scopedPair()[1] });
const policy = () => ({ Version: "2012-10-17", Statement: [
  { Effect: "Allow", Action: ["s3:ListBucket"], Resource: [`arn:aws:s3:::${bucket()}`] },
  { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource: [`arn:aws:s3:::${bucket()}/*`] },
] });
async function command(argv: string[], env = Bun.env) {
  const child = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe" });
  const stderr = async () => {
    const reader = child.stderr.getReader();
    let tail = Buffer.alloc(0), truncated = false;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        const bytes = Buffer.concat([tail, value]); truncated ||= bytes.length > 1500;
        tail = Buffer.from(bytes.subarray(-1500));
      }
    } finally { reader.releaseLock(); }
    // Drop a cut line so truncation cannot expose a secret suffix or hide its header/key.
    return truncated ? tail.subarray(tail.indexOf(10) < 0 ? tail.length : tail.indexOf(10) + 1).toString() : tail.toString();
  };
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), stderr()]);
  if (code) {
    let diagnostic = err.replace(/\bAuthorization["']?\s*:\s*[^\r\n]*/gi, "Authorization: [REDACTED]")
      .replace(/^.*$/gm, (line) => [...line.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=/g)]
        .some((match) => /SECRET|PASSWORD|TOKEN/i.test(match[1] ?? "")) ? "[REDACTED credential assignment]" : line);
    const secrets = [...Object.entries(Bun.env), ...Object.entries(env)]
      .filter(([key, value]) => value && /SECRET|PASSWORD|TOKEN|^BP_RUSTFS_ROOT_USER$|^BP_BLOB_S3_ACCESS_KEY$/i.test(key))
      .map(([, value]) => value ?? "").sort((a, b) => b.length - a.length);
    for (const value of secrets) diagnostic = diagnostic.replaceAll(value, "[REDACTED]");
    diagnostic = [...diagnostic].filter((char) => char === "\n" || char === "\t" || (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)).join("");
    console.error(`child exited ${code}: ${Buffer.from(diagnostic).subarray(0, 1500).toString() || "no complete stderr line retained"}`);
    if (Bun.env.BP_ACCEPTANCE_DEBUG) console.error(`[debug] child stderr\n${err}`);
  }
  return { code, out };
}
async function signed(method: string, path: string, body = "", pair: readonly [string, string] = rootPair()) {
  const url = new URL(path, "http://rustfs:9000"), date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8), scope = `${day}/us-east-1/s3/aws4_request`;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const headers = { host: url.host, "x-amz-content-sha256": hash(body), "x-amz-date": date };
  const canonical = [method, url.pathname, url.search.slice(1),
    Object.entries(headers).map(([name, value]) => `${name}:${value}\n`).join(""),
    "host;x-amz-content-sha256;x-amz-date", hash(body)].join("\n");
  let key = Buffer.from(`AWS4${pair[1]}`);
  for (const part of [day, "us-east-1", "s3", "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).digest("hex");
  const response = await fetch(url, { method, ...(body ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { ...headers, "content-type": "application/json", authorization:
      `AWS4-HMAC-SHA256 Credential=${pair[0]}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}` } });
  return { status: response.status, text: await response.text() };
}
const admin = "/rustfs/admin/v3/";
async function checked(method: string, path: string, body = "") {
  const result = await signed(method, path, body); assert(result.status >= 200 && result.status < 300, `root request failed: ${method} ${path.split("?")[0]} (${result.status})`);
  return result.text;
}
async function bootstrap(env = Bun.env) {
  return (await command(["bun", "/app/infra/init/blobs/bootstrap.js"], env)).code;
}
async function inventory(workspace: string, endpoint = "http://rustfs:9000") {
  const client = new S3Client(options(endpoint)), keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.list({ prefix: `${workspace}/`, maxKeys: 64, ...(token ? { continuationToken: token } : {}) });
    keys.push(...(page.contents ?? []).map((object) => object.key)); token = page.nextContinuationToken;
  } while (token);
  return keys.sort();
}

async function credentialsScenario() {
  const query = `?accessKey=${scopedPair()[0]}`;
  const info = async () => JSON.parse(await checked("GET", `${admin}info-service-account${query}`));
  const accountKeys = async () => {
    const result = JSON.parse(await checked("GET", `${admin}list-service-accounts?user=${rootPair()[0]}`));
    assert(Array.isArray(result.accounts), "service-account listing must be unambiguous");
    return result.accounts.map((account: { accessKey: string }) => account.accessKey).sort();
  };
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalize(item)])
      .filter(([, item]) => item !== null && item !== "" && !(typeof item === "object" && Object.keys(item).length === 0)));
    return value;
  };
  const assertPolicy = async (expected = policy()) => {
    const account = await info(); assert.equal(account.parentUser, rootPair()[0]); assert.equal(account.impliedPolicy, false);
    const stored = typeof account.policy === "string" ? JSON.parse(account.policy) : account.policy;
    assert.deepEqual(normalize(stored), normalize(expected));
  };
  const allowed = async () => {
    for (const [method, path, body] of [["GET", `/${bucket()}?list-type=2`, ""], ["PUT", `/${bucket()}/probe`, "bytes"],
      ["GET", `/${bucket()}/probe`, ""], ["DELETE", `/${bucket()}/probe`, ""]]) {
      assert(method && path); const result = await signed(method, path, body, scopedPair());
      assert(result.status >= 200 && result.status < 300, `scoped ${method} failed`);
      if (method === "GET" && path.endsWith("/probe")) assert.equal(result.text, "bytes");
    }
  };
  const denied = async () => {
    const foreign = `${bucket()}-foreign`;
    await checked("PUT", `/${foreign}`);
    await checked("PUT", `/${foreign}/probe`, "foreign bytes");
    for (const [method, path, body] of [
      ["GET", `/${foreign}?list-type=2`, ""], ["GET", `/${foreign}/probe`, ""],
      ["PUT", `/${foreign}/probe`, "overwrite"], ["DELETE", `/${foreign}/probe`, ""],
      ["PUT", `/${bucket()}-forbidden`, ""], ["DELETE", `/${foreign}`, ""],
      ["PUT", `/${bucket()}?versioning=`, '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>'],
      ["DELETE", `/${bucket()}/probe?versionId=null`, ""],
      ["PUT", `${admin}add-service-account`, JSON.stringify({ targetUser: rootPair()[0], accessKey: "forbiddenkey", secretKey: "forbidden-secret-value", policy: policy() })],
      ["POST", `${admin}update-service-account${query}`, JSON.stringify({ newPolicy: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:*"], Resource: ["arn:aws:s3:::*"] }] } })],
    ]) {
      assert(method && path); assert.equal((await signed(method, path, body, scopedPair())).status, 403, `permission escaped: ${method} ${path.split("?")[0]}`);
    }
    // RustFS 1.0.0-rc.6 lets a ListBucket-only key read versioning state; only writes and version listings must stay denied.
    for (const path of [`/${bucket()}?versioning=`, `/${bucket()}?versions=`]) {
      const status = (await signed("GET", path, "", scopedPair())).status;
      assert([200, 403].includes(status), `unexpected status ${status} for GET ${path.split("?")[0]} sub-resource`);
    }
    await checked("DELETE", `/${foreign}/probe`); await checked("DELETE", `/${foreign}`);
  };
  await assertPolicy(); await allowed(); await denied();
  const before = await accountKeys(); assert.deepEqual(before, [scopedPair()[0]]);
  assert.equal(await bootstrap(), 0); assert.deepEqual(await accountKeys(), before); await assertPolicy();
  const oldPair = scopedPair(), rotated = randomBytes(20).toString("hex");
  const broad = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:*"], Resource: ["arn:aws:s3:::*"] }] };
  await checked("POST", `${admin}update-service-account${query}`, JSON.stringify({ newPolicy: broad }));
  await assertPolicy(broad);
  const foreign = `${bucket()}-foreign`;
  await checked("PUT", `/${foreign}`);
  try {
    assert.equal((await signed("PUT", `/${foreign}/probe`, "broadened access", oldPair)).status, 200);
    assert.equal(await checked("GET", `/${foreign}/probe`), "broadened access");
  } finally { await checked("DELETE", `/${foreign}/probe`); await checked("DELETE", `/${foreign}`); }
  try {
    assert.notEqual(await bootstrap({ ...Bun.env,
      BP_BLOB_S3_ACCESS_KEY: randomBytes(10).toString("hex"),
      BP_BLOB_S3_SECRET_KEY: randomBytes(32).toString("hex"),
    }), 0, "overlong new service-account secret accepted");
    assert.deepEqual(await accountKeys(), before);
    assert.equal((await signed("GET", `/${bucket()}?list-type=2`, "", oldPair)).status, 200);
    Bun.env.BP_BLOB_S3_SECRET_KEY = rotated;
    assert.equal(await bootstrap(), 0); await assertPolicy(); await allowed(); await denied();
    assert.equal((await signed("GET", `/${bucket()}?list-type=2`, "", oldPair)).status, 403);
    assert.deepEqual(await accountKeys(), before);
  } finally { Bun.env.BP_BLOB_S3_SECRET_KEY = oldPair[1]; assert.equal(await bootstrap(), 0); }
  const versioned = `${bucket()}-versioned`;
  await checked("PUT", `/${versioned}`);
  for (const status of ["Enabled", "Suspended"]) {
    await checked("PUT", `/${versioned}?versioning=`, `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${status}</Status></VersioningConfiguration>`);
    assert.notEqual(await bootstrap({ ...Bun.env, BP_BLOB_S3_BUCKET: versioned }), 0, `${status} bucket accepted`);
    await assertPolicy();
  }
  await checked("DELETE", `/${versioned}`);
}

async function transportScenario() {
  const listings: URL[] = [];
  const proxy = Bun.serve({ hostname: "0.0.0.0", port: 0, async fetch(request) {
    const url = new URL(request.url); if (url.searchParams.has("list-type")) listings.push(url);
    const headers = new Headers(request.headers); headers.set("host", url.host);
    return fetch(`http://rustfs:9000${url.pathname}${url.search}`, { method: request.method, headers,
      ...(request.method === "PUT" ? { body: await request.arrayBuffer() } : {}), redirect: "error" });
  } });
  const endpoint = `http://localhost:${proxy.port}`, disk = s3Store(options(endpoint));
  let failure = "", blockRemoval = true;
  const storage = { ...disk,
    async stage(w: string, id: string, bytes: Uint8Array) { await disk.stage(w, id, bytes); if (failure === "stage") throw new Error("stage_failed"); },
    async promote(w: string, id: string, bytes: Uint8Array) { await disk.promote(w, id, bytes); if (failure === "final") throw new Error("promotion_failed"); },
    async remove(w: string, ref: { id: string; staging: boolean }) { if (blockRemoval) throw new Error("delete_failed"); await disk.remove(w, ref); },
  };
  const cleanup: (() => Promise<unknown> | unknown)[] = [];
  let failed = false, cleanupFailed = false;
  try {
    const f = await fixture(storage); cleanup.push(() => f.close());
    const other = await fixture(s3Store(options())); cleanup.push(() => other.close());
    const bytes = Buffer.from("RustFS\0presigned transport\n"), keep = await uploaded(await f.put("keep", bytes));
    assert.equal(keep.sha256, blobHash(bytes));
    assert.deepEqual(Buffer.from(await (await f.get(keep.id)).arrayBuffer()), bytes);
    assert.deepEqual(Buffer.from(await disk.open(f.workspaceId, keep.id)), bytes);
    const foreign = await uploaded(await other.put("foreign", "other Workspace"));
    for (const mode of ["stage", "final"]) {
      failure = mode;
      for (let i = 0; i < 130; i++) assert.equal((await f.put(`${mode}-${i}`)).status, 503);
    }
    failure = "";
    const before = await inventory(f.workspaceId);
    assert.equal(before.length, 261); assert.equal(before.filter((key) => key.includes("/staging/")).length, 130);
    const [rows] = await f.pool`SELECT count(*)::int AS n FROM control.blobs WHERE workspace_id=${f.workspaceId}`;
    assert.equal(rows.n, 1);
    listings.length = 0;
    const scanned = new Set<string>(), pager = s3Store(options(endpoint));
    for (let page = 0; page < 5; page++) {
      const refs = await pager.scanPage(f.workspaceId); assert(refs.length <= 64);
      for (const ref of refs) scanned.add(`${f.workspaceId}/${ref.staging ? "staging/" : ""}${ref.id}`);
    }
    assert.deepEqual([...scanned].sort(), before);
    assert(listings.some((url) => url.searchParams.has("continuation-token")));
    assert(listings.every((url) => !url.searchParams.has("start-after")));
    blockRemoval = false;
    for (let page = 0; page < 12; page++) await cleanupBlobs(f.pool, f, f.store);
    assert.deepEqual(await inventory(f.workspaceId), [`${f.workspaceId}/${keep.id}`]);
    assert.equal(await (await other.get(foreign.id)).text(), "other Workspace");
    assert.deepEqual(await inventory(other.workspaceId), [`${other.workspaceId}/${foreign.id}`]);
    assert.equal((await f.del(keep.id)).status, 204); assert.deepEqual(await inventory(f.workspaceId), []);
  } catch (error) { failed = true; throw error; }
  finally {
    blockRemoval = false; failure = "";
    const results = await Promise.allSettled(cleanup.map(close => Promise.resolve().then(close)));
    results.push(...await Promise.allSettled([Promise.resolve().then(() => proxy.stop(true))]));
    if (results.some(result => result.status === "rejected")) {
      if (failed) console.error("RustFS transport cleanup also failed");
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) throw new Error("RustFS transport cleanup failed");
}

type RecoveryState = { database: string; workspaceId: string; principalId: string; runId: string; cookie: string; key: string; keep: string; orphan: string };
const exchange = "/exchange/recovery.json";
async function commitScenario() {
  const f = await fixture(s3Store(options()), false);
  try {
    f.faults("commit"); const keep = await uploaded(await f.put("committed"));
    assert.equal(await (await f.get(keep.id)).text(), "private bytes");
    assert.equal(blobHash(await f.disk.open(f.workspaceId, keep.id)), keep.sha256);
    f.deleteFault("rollback"); assert.equal((await f.del(keep.id, f.userHeaders)).status, 503);
    assert.equal(await (await f.get(keep.id)).text(), "private bytes");
    const deleted = await uploaded(await f.put("delete-committed"));
    f.deleteFault("committed"); assert.equal((await f.del(deleted.id, f.userHeaders)).status, 204);
    assert.equal((await f.get(deleted.id)).status, 404); await assert.rejects(f.disk.open(f.workspaceId, deleted.id));
    const orphan = await uploaded(await f.put("cleanup-pending"));
    f.faults("remove"); assert.equal((await f.del(orphan.id)).status, 204);
    assert.equal((await f.get(orphan.id)).status, 404); assert.equal(blobHash(await f.disk.open(f.workspaceId, orphan.id)), orphan.sha256);
    const [row] = await f.pool`SELECT current_database() AS name`;
    const state: RecoveryState = { database: row.name, workspaceId: f.workspaceId, principalId: f.principalId,
      runId: f.runId, cookie: f.cookie, key: f.key, keep: keep.id, orphan: orphan.id };
    await Bun.write(exchange, JSON.stringify(state));
  } finally { await f.close(); }
}
async function recoveryScenario() {
  const state: RecoveryState = await Bun.file(exchange).json();
  const pool = createPool(`postgres://bp_server:bp_server@restored-postgres:55432/${state.database}`), disk = s3Store(options());
  const appCleanups: (() => Promise<void>)[] = [];
  let cleanupFailed = false;
  try {
    const app = await testApp(pool, { blobStore: disk }, cleanup => appCleanups.push(cleanup));
    const [gate] = await pool`SELECT epoch,active FROM control.restore_gate WHERE singleton`; assert.equal(gate.active, true);
    const before = await inventory(state.workspaceId);
    assert.deepEqual(before, [`${state.workspaceId}/${state.keep}`, `${state.workspaceId}/${state.orphan}`].sort());
    assert.equal(await cleanupBlobs(pool, state, disk), true);
    assert.equal(await cleanupBlobs(pool, state, disk, [state.orphan]), true);
    assert.deepEqual(await inventory(state.workspaceId), before);
    const base = `http://localhost/api/v1/workspaces/${state.workspaceId}`;
    const headers = { authorization: `Bearer ${state.key}`, "x-backplane-run": state.runId };
    const download = await app.handle(new Request(`${base}/blobs/${state.keep}`, { headers }));
    assert.equal(download.status, 200); assert.equal(await download.text(), "private bytes");
    const released = await app.handle(new Request(`${base}/restore/release`, { method: "POST",
      headers: { cookie: state.cookie, origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ epoch: gate.epoch, sourceFenced: true }) }));
    assert.equal(released.status, 200); assert.equal((await released.json()).done, true);
    const [after] = await pool`SELECT active FROM control.restore_gate WHERE singleton`; assert.equal(after.active, false);
    assert.equal(await cleanupBlobs(pool, state, disk), false);
    assert.deepEqual(await inventory(state.workspaceId), [`${state.workspaceId}/${state.keep}`]);
    assert.equal(blobHash(await disk.open(state.workspaceId, state.keep)), blobHash(Buffer.from("private bytes")));
  } finally {
    const results = await Promise.allSettled([pool.close(), ...appCleanups.map(cleanup => cleanup())]);
    cleanupFailed = results.some(result => result.status === "rejected");
    if (cleanupFailed) console.error("recovery fixture cleanup failed");
  }
  if (cleanupFailed) throw new Error("recovery fixture cleanup failed");
}

async function orchestrate() {
  assert(Bun.which("docker"), "docker is required; RustFS acceptance never skips");
  const root = resolve(import.meta.dir, "../.."), scratch = await mkdtemp(join(tmpdir(), "bp-rustfs-"));
  // The worker container runs as a different uid; the exchange directory must be writable to it.
  const exchangeDir = join(scratch, "exchange"); await mkdir(exchangeDir, { mode: 0o777 }); await chmod(exchangeDir, 0o777);
  const env = { ...Bun.env, BP_RUSTFS_ROOT_USER: randomBytes(10).toString("hex"), BP_RUSTFS_ROOT_PASSWORD: randomBytes(32).toString("hex"),
    BP_BLOB_S3_ACCESS_KEY: randomBytes(10).toString("hex"), BP_BLOB_S3_SECRET_KEY: randomBytes(20).toString("hex"), BP_BLOB_S3_BUCKET: "backplane",
    BP_AUTH_SECRET: crypto.randomUUID(), BP_POSTGRES_ADMIN_PASSWORD: "postgres", BP_POSTGRES_PASSWORD: "bp_server",
    BP_BACKUP_DIR: join(scratch, "backup"), BP_PUBLIC_URL: "http://localhost:3000", BP_PORT: "0", BP_POSTGRES_PORT: "0" };
  const project = `s33-${crypto.randomUUID().slice(0, 8)}`;
  const core = await command(["docker", "compose", "--project-directory", root, "-f", join(root, "compose.yaml"), "config", "--format", "json"], env);
  assert.equal(core.code, 0, "core Compose config failed");
  const postgresImage: string = JSON.parse(core.out).services.postgres.image;
  const override = join(scratch, "acceptance.yaml");
  await Bun.write(override, JSON.stringify({ services: {
    "backup-init": { volumes: ["acceptance-backup:/backup"] },
    postgres: { volumes: ["acceptance-backup:/backup", "restored-data:/recovery"] },
    server: { volumes: ["acceptance-backup:/backups:ro"] },
    "restored-postgres": { image: postgresImage, profiles: ["recovery"],
      entrypoint: ["sh", "-ec", "exec gosu postgres postgres -D /recovery/data -p 55432 -c listen_addresses='*' -c archive_mode=off"],
      volumes: ["restored-data:/recovery"],
    },
    "blob-bootstrap": {
      networks: ["default", "blob-internal"], volumes: [`${root}:/work:ro`, `${exchangeDir}:/exchange`], tmpfs: ["/tmp"],
      environment: { BP_TEST_POSTGRES_URL: "postgres://postgres:postgres@postgres:5432/postgres", BP_BLOB_BACKEND: "s3",
        BP_ACCEPTANCE_DEBUG: Bun.env.BP_ACCEPTANCE_DEBUG ?? "",
        BP_BLOB_S3_ENDPOINT: "http://rustfs:9000", BP_BLOB_S3_REGION: "us-east-1" },
    },
  }, networks: { platform: { external: false, name: `${project}-platform` } },
    volumes: { "acceptance-backup": {}, "restored-data": {}, ...Object.fromEntries(["postgres-data", "server-data", "rustfs-data"].map(name => [name, { external: false, name: `${project}_${name}` }])) } }));
  const base = ["docker", "compose", "--project-name", project,
    "--project-directory", root, "-f", join(root, "compose.yaml"),
    "-f", join(root, "compose.blobs.yaml"), "-f", join(root, "compose.dev.yaml"), "-f", override, "--profile", "blobs"];
  const compose = async (...args: string[]) => {
    const result = await command([...base, ...args], env); assert.equal(result.code, 0, `Compose ${args[0]} failed (output withheld to protect credentials)`); return result.out;
  };
  const worker = (phase: string) => compose("run", "--rm", "--no-deps", "--entrypoint", "bun", "--workdir", "/work",
    "blob-bootstrap", "/work/tests/acceptance/rustfs.ts", phase);
  try {
    await compose("version");
    const config = JSON.parse(await compose("config", "--no-env-resolution", "--format", "json"));
    const serverEnv = config.services.server.environment;
    assert(!config.services.server.env_file, "S32 must remove server env_file before RustFS acceptance");
    for (const [key, value] of Object.entries(serverEnv)) {
      assert(!/RUSTFS_ROOT|MINIO_ROOT/.test(key), "root configuration reached the server");
      assert(value !== env.BP_RUSTFS_ROOT_USER && value !== env.BP_RUSTFS_ROOT_PASSWORD, "root credential reached the server");
    }
    await compose("up", "--detach", "--build");
    for (let attempt = 0; ; attempt++) {
      const probe = await command([...base, "exec", "-T", "server", "curl", "-fsS", "http://localhost:3000/health/ready"], env);
      if (!probe.code) break; assert(attempt < 90, "server readiness deadline exceeded"); await Bun.sleep(1000);
    }
    const id = (await compose("ps", "-q", "server")).trim();
    const inspected = await command(["docker", "inspect", id], env); assert.equal(inspected.code, 0);
    const runtime: string[] = JSON.parse(inspected.out)[0].Config.Env;
    assert(runtime.every((value) => !/RUSTFS_ROOT|MINIO_ROOT/.test(value)
      && !value.includes(env.BP_RUSTFS_ROOT_PASSWORD) && !value.includes(env.BP_RUSTFS_ROOT_USER)), "root credentials reached running server");
    await worker("--credentials"); console.log("PASS 1: bootstrap reruns broaden privileges or duplicate credentials");
    await worker("--transport"); console.log("PASS 2: RustFS transport or paging strands bytes");
    await worker("--commit");
    await compose("stop", "server");
    const state: RecoveryState = await Bun.file(join(exchangeDir, "recovery.json")).json();
    await compose("cp", "blob-bootstrap:/usr/local/bin/bun", join(scratch, "bun"));
    await compose("cp", join(scratch, "bun"), "postgres:/tmp/s33-bun");
    await compose("cp", join(root, "apps/server/restore/backup-restore.ts"), "postgres:/tmp/s33-recovery.ts");
    const pg = (...args: string[]) => compose("exec", "-T", "--user", "postgres", "postgres", ...args);
    const dataDir = (await pg("psql", "-U", "postgres", "-d", state.database, "-Atc", "SHOW data_directory")).trim();
    const binDir = (await pg("pg_config", "--bindir")).trim();
    const recovery = (operation: string, directory: string) => pg("sh", "-ec",
      `umask 077; file=$(mktemp); trap 'rm -f "$file"' EXIT; printf 'postgres://postgres:%s@localhost:5432/%s' "$POSTGRES_PASSWORD" "$1" > "$file"; export BP_BACKUP_ADMIN_URL_FILE="$file"; unset POSTGRES_PASSWORD; shift; "$@"`,
      "sh", state.database, "/tmp/s33-bun", "/tmp/s33-recovery.ts", operation, directory, "/tmp/s33-backup", "/backup/archive", binDir);
    await recovery("backup", dataDir);
    await compose("exec", "-T", "--user", "0", "postgres", "chown", "postgres:postgres", "/recovery");
    await recovery("restore", "/recovery/data");
    await compose("stop", "postgres");
    await compose("up", "--detach", "--no-deps", "restored-postgres");
    for (let attempt = 0; ; attempt++) {
      const probe = await command([...base, "exec", "-T", "restored-postgres", "pg_isready", "-p", "55432"], env);
      if (!probe.code) break; assert(attempt < 30, "restored Postgres readiness deadline exceeded"); await Bun.sleep(1000);
    }
    await worker("--recovery");
    console.log("PASS 3: lost database acknowledgement destroys committed bytes or cleanup ignores recovery");
  } finally {
    try { await compose("--profile", "*", "down", "--volumes", "--remove-orphans");
      const remaining = await command(["docker", "ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], env);
      assert.equal(remaining.code, 0); assert.equal(remaining.out.trim(), "", "acceptance containers survived cleanup");
      const volumes = await command(["docker", "volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`], env);
      assert.equal(volumes.code, 0); assert.equal(volumes.out.trim(), "", "acceptance volumes survived cleanup"); }
    finally { await rm(scratch, { recursive: true, force: true }); }
  }
}

const phase = Bun.argv[2];
try {
  if (phase === "--credentials") await credentialsScenario();
  else if (phase === "--transport") await transportScenario();
  else if (phase === "--commit") await commitScenario();
  else if (phase === "--recovery") await recoveryScenario();
  else { assert(!phase, "unknown acceptance phase"); await orchestrate(); }
} catch (error) {
  console.error(error instanceof assert.AssertionError ? error.message : "RustFS acceptance failed; child output withheld to protect credentials");
  if (Bun.env.BP_ACCEPTANCE_DEBUG) console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
}
// Teardown has finished by now; exit explicitly so a failure can never be reported as success.
if (process.exitCode) process.exit(process.exitCode);
