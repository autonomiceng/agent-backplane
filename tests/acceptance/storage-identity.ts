import { capabilityProbe } from "../../apps/server/platform/capability-probe.ts";
// Real RustFS/PostgreSQL identity gate. Every resource belongs to this invocation.
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { startCluster, migratedDatabase, adminUrl, type TestCluster } from "../../apps/server/testing/postgres.ts";
import { createPool } from "../../apps/server/platform/pool.ts";
import { s3Store } from "../../apps/server/blobs/s3-store.ts";
import { adoptStorage, type AdoptionOptions } from "../../apps/server/blobs/storage-adoption.ts";
import { verifyStorageBinding } from "../../apps/server/blobs/storage-binding.ts";

const image = "rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff";
const name = "bp-storage-identity-" + crypto.randomUUID(), access = crypto.randomUUID(), secret = crypto.randomUUID();
const pools: ReturnType<typeof createPool>[] = [];
let container: string | undefined, cluster: TestCluster | undefined;
async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, RUSTFS_ACCESS_KEY: access, RUSTFS_SECRET_KEY: secret } });
  const timeout = setTimeout(() => child.kill(), 120000);
  try {
    const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(code, 0, `owned identity fixture Docker ${args[0]} failed`); return out.trim();
  } finally { clearTimeout(timeout); }
}
const initialize: AdoptionOptions = { mode: "initialize", checkpoint: "", fenced: false, retain: false };
async function database() {
  const url = await migratedDatabase(), pool = createPool(adminUrl(url)); pools.push(pool); return pool;
}
try {
  // Clean CI runners have no image cache; acquire the exact qualified artifact.
  await docker("pull", image);
  container = await docker("create", "--name", name, "--pull", "never", "--memory", "2g", "--publish", "127.0.0.1::9000",
    "--tmpfs", "/data:rw,mode=1777", "--env", "RUSTFS_ACCESS_KEY", "--env", "RUSTFS_SECRET_KEY",
    "--env", "RUSTFS_ADDRESS=:9000", "--env", "RUSTFS_CONSOLE_ENABLE=false", "--env", "RUSTFS_OBS_LOG_DIRECTORY=", image, "/data");
  await docker("start", container);
  const endpoint = "http://" + await docker("port", container, "9000"), deadline = performance.now() + 60000;
  while (true) {
    const response = await fetch(endpoint + "/health", { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    await response?.body?.cancel(); if (response?.ok) break;
    assert(performance.now() < deadline, "RustFS readiness deadline exceeded"); await Bun.sleep(250);
  }
  cluster = await startCluster(); Bun.env.BP_TEST_POSTGRES_URL = cluster.url;
  async function store() {
    const bucket = "binding-" + crypto.randomUUID();
    const options = { endpoint, bucket, region: "us-east-1", accessKeyId: access, secretAccessKey: secret };
    // Bucket creation is an operator S3 operation, outside the blob adapter's object API.
    const url = new URL(`/${bucket}`, endpoint), date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = date.slice(0, 8), scope = `${day}/us-east-1/s3/aws4_request`;
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    const canonical = ["PUT", url.pathname, "", `host:${url.host}\nx-amz-content-sha256:${hash("")}\nx-amz-date:${date}\n`,
      "host;x-amz-content-sha256;x-amz-date", hash("")].join("\n");
    let key = Buffer.from(`AWS4${secret}`);
    for (const part of [day, "us-east-1", "s3", "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
    const signature = createHmac("sha256", key).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).digest("hex");
    const created = await fetch(url, { method: "PUT", signal: AbortSignal.timeout(10000), headers: {
      "x-amz-date": date, "x-amz-content-sha256": hash(""), authorization:
        `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}` } });
    await created.body?.cancel(); assert(created.ok, `owned bucket creation failed (${created.status})`);
    return s3Store(options);
  }
  const shared = await store(), a = await database(), b = await database();
  const raced = await Promise.allSettled([adoptStorage(a, shared, initialize), adoptStorage(b, shared, initialize)]);
  assert.equal(raced.filter(result => result.status === "fulfilled").length, 1, "conditional publication allowed two database owners");
  const winner = raced[0]?.status === "fulfilled" ? a : b, loser = winner === a ? b : a;
  const marker = await shared.readMarker();
  const release = await verifyStorageBinding(winner, shared); await release();
  assert.equal((await capabilityProbe(winner, shared)()).files.state, "healthy");
  assert.equal((await capabilityProbe(loser, shared)()).files.state, "unavailable");
  await assert.rejects(adoptStorage(loser, shared, initialize));
  assert.deepEqual(await shared.readMarker(), marker, "loser changed the store owner");

  const uncertain = await store(), retry = await database();
  await assert.rejects(adoptStorage(retry, { ...uncertain, async publishMarker(bytes) {
    await uncertain.publishMarker(bytes); throw new Error("injected_lost_publication_acknowledgement");
  } }, initialize));
  const [intent] = await retry`SELECT phase FROM control.blob_storage_binding`; assert.equal(intent.phase, "verifying");
  const published = await uncertain.readMarker();
  await adoptStorage(retry, uncertain, initialize); assert.deepEqual(await uncertain.readMarker(), published);
  const releaseRetry = await verifyStorageBinding(retry, uncertain); await releaseRetry();

  const inaccessible = await database();
  await assert.rejects(adoptStorage(inaccessible, { ...uncertain, async markerOrAbsent() { throw new Error("injected_get_failure"); } }, initialize));
  const [untouched] = await inaccessible`SELECT count(*)::int AS count FROM control.blob_storage_binding`; assert.equal(untouched.count, 0);
  assert.deepEqual(await uncertain.readMarker(), published);
  console.log("PASS: real RustFS competing database publication, immutable winner, ambiguous publication retry, read failure refusal; no installed storage touched");
} finally {
  await Promise.all(pools.map(pool => pool.close()));
  await cluster?.stop();
  if (container) await docker("rm", "--force", "--volumes", container);
}
