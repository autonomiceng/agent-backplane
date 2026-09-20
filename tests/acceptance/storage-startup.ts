// Root-run process gate: legacy refusal, explicit adoption and loss of runtime ownership.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { startCluster } from "../../apps/server/testing/postgres.ts";
import { adoptionFixture, adoption } from "../../apps/server/blobs/testing/storage-adoption-fixture.ts";
const cluster = await startCluster(); Bun.env.BP_TEST_POSTGRES_URL = cluster.url;
const fixture = await adoptionFixture();
const children: ReturnType<typeof Bun.spawn>[] = [];
const root = resolve(import.meta.dir, "../.."), secret = crypto.randomUUID(), operations = crypto.randomUUID();
async function start() {
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port; await reservation.stop(true);
  const env = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith("BP_")));
  const child = Bun.spawn(["bun", "apps/server/main.ts"], { cwd: root, stdout: "pipe", stderr: "pipe", env: {
    ...env, BP_DATABASE_URL: fixture.url, BP_DATA_DIR: fixture.dataDir, BP_AUTH_SECRET: secret, BP_PORT: String(port),
    BP_PUBLIC_URL: `http://localhost:${port}`, BP_OPERATIONS_TOKEN: operations, BP_RETENTION_PURGE_INTERVAL: "100ms",
  } });
  children.push(child);
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { child, output, origin: `http://127.0.0.1:${port}` };
}
async function exited(child: ReturnType<typeof Bun.spawn>, timeout = 10000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([child.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("owned server did not stop before deadline")), timeout); })]); }
  finally { clearTimeout(timer); }
}
try {
  const blob = await fixture.legacy();
  const bytes = await fixture.store.open(blob.workspaceId, blob.id);
  const refused = await start(); assert.equal(await exited(refused.child), 1);
  const [out, err] = await refused.output;
  assert(err.includes("blob_binding_required"), "legacy refusal did not identify adoption requirement");
  assert(!out.includes("listening") && !out.includes("retention.purge"), "refused server admitted traffic or purge");
  assert.deepEqual(await fixture.store.open(blob.workspaceId, blob.id), bytes);
  await assert.rejects(readFile(resolve(fixture.dataDir, "blobs/.backplane-store")));
  await fixture.operate(adoption);
  async function ready(active: Awaited<ReturnType<typeof start>>) {
    const deadline = performance.now() + 15000;
    while (true) {
      const response = await fetch(active.origin + "/health/ready", { headers: { authorization: `Bearer ${operations}` }, signal: AbortSignal.timeout(1000) }).catch(() => undefined);
      await response?.body?.cancel(); if (response?.ok) return;
      assert(active.child.exitCode === null, "adopted server exited before readiness");
      assert(performance.now() < deadline, "adopted server readiness deadline exceeded"); await Bun.sleep(100);
    }
  }
  const active = await start(); await ready(active);
  const locks = await fixture.admin<{ pid: number }[]>`SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=112933 AND objid=32 AND objsubid=2 AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;
  assert.equal(locks.length, 1); assert(locks[0]);
  await fixture.admin`SELECT pg_terminate_backend(${locks[0].pid})`;
  assert.equal(await exited(active.child), 1);
  const [, lost] = await active.output; assert(lost.includes("blob_binding_lease_lost"));
  const response = await fetch(active.origin + "/health/live", { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
  assert.equal(response, undefined, "server listener survived lost ownership");
  assert.deepEqual(await fixture.store.open(blob.workspaceId, blob.id), bytes);
  const beforeRestart = await start(); await ready(beforeRestart);
  await cluster.restart();
  assert.equal(await exited(beforeRestart.child), 1);
  const [, restarted] = await beforeRestart.output; assert(restarted.includes("blob_binding_lease_lost"));
  const recovered = await start(); await ready(recovered);
  assert.deepEqual(await fixture.store.open(blob.workspaceId, blob.id), bytes);
  console.log("PASS: unbound legacy startup preserves bytes and starts no listener/purge; explicit adoption starts the real server; session loss and PostgreSQL restart exit the old process; a new process recovers the unchanged store");
} finally {
  for (const child of children) if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  await fixture.close(); await cluster.stop();
}
