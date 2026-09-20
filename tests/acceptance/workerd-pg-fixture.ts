// Three real-PG + actual-runtime cases. Runtime API service must target BP_TEST_API_PORT on this host.
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool } from "../../apps/server/platform/pool.ts";
import { migratedDatabase } from "../../apps/server/testing/postgres.ts";
import { principalFixture, issueKey, createRun, applyMigration, testApp } from "../../apps/server/testing/session.ts";
import { createComputeLauncher } from "../../apps/server/compute/compute-launcher.ts";

export async function workerdPgFixture() {
  if (!Bun.env.BP_TEST_API_PORT) throw Error("BP_TEST_API_PORT must match the owned runtime's API service address");
  const databaseUrl = await migratedDatabase(), pool = createPool(databaseUrl);
  const directory = await mkdtemp(join(tmpdir(), "bp-workerd-server-"));
  const cleanups: (() => Promise<void>)[] = [];
  const cleanupFixtures = async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); };
  let server: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined, address: string;
  try {
  const f = await principalFixture(pool, {}, cleanup => { cleanups.push(cleanup); });
  const { workspaceId, principalId: callerId, cookie } = f;
  const callerKey = await issueKey(f.app, cookie, workspaceId, callerId), callerRun = await createRun(f.app, callerKey, workspaceId);
  const base = `http://localhost/api/v1/workspaces/${workspaceId}`;
  const userHeaders = { cookie, origin: "http://localhost", "content-type": "application/json" };
  const owner = await f.app.handle(new Request(`${base}/principals`, { method: "POST", headers: userHeaders, body: JSON.stringify({ name: "Function" }) }));
  expect(owner.status).toBe(201);
  const ownerId: string = (await owner.json()).id;
  const ownerKey = await issueKey(f.app, cookie, workspaceId, ownerId), ownerRun = await createRun(f.app, ownerKey, workspaceId);
  await applyMigration(f.app, ownerKey, ownerRun, workspaceId, "CREATE TABLE runtime_proof (id text PRIMARY KEY, value text)");
  const compute = createComputeLauncher({ url: Bun.env.BP_COMPUTE_URL, token: Bun.env.BP_COMPUTE_TOKEN, runtimeDigest: Bun.env.BP_WORKERD_RUNTIME_ID, timeoutMs: Bun.env.BP_COMPUTE_TIMEOUT_MS });
  if (!compute || !await compute.verify(AbortSignal.timeout(2000))) throw Error("actual runtime verification required");
  const app = await testApp(pool, { compute }, cleanup => { cleanups.push(cleanup); });
  const headers = (key = callerKey, run = callerRun) => ({ authorization: `Bearer ${key}`, "x-backplane-run": run, "content-type": "application/json" });
  async function start() {
    server = Bun.spawn([process.execPath, "tests/acceptance/workerd-server-fixture.ts"], { stdin: "ignore", stdout: "pipe", stderr: "inherit",
      env: { ...Bun.env, BP_TEST_DATABASE_URL: databaseUrl, BP_TEST_SERVER_DIRECTORY: directory } });
    const reader = server.stdout.getReader(), timer = setTimeout(() => server?.kill("SIGKILL"), 10000);
    try {
      let lines = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw Error("server fixture exited before listening");
        lines += new TextDecoder().decode(value);
        const found = lines.split("\n").find(line => line.startsWith('{"url":'));
        if (found) { address = JSON.parse(found).url; break; }
      }
    } finally { clearTimeout(timer); reader.releaseLock(); }
  }
  await start();
  const post = (path: string, body: unknown, actor = headers()) => fetch(new URL(`/api/v1/workspaces/${workspaceId}${path}`, address), {
    method: "POST", headers: actor, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  async function deploy(name: string, bundle: string, outboundUrls: string[] = []) {
    const id = crypto.randomUUID();
    expect((await post(`/functions/${name}/deployments`, { id, bundle, entryPoint: "default", outboundUrls }, headers(ownerKey, ownerRun))).status).toBe(201);
    expect((await post(`/functions/${name}/deployments/${id}/activate`, { expectedActiveId: null }, headers(ownerKey, ownerRun))).status).toBe(200);
    return id;
  }
  async function observed(deployment: string) {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const [row] = await pool<{ id: string }[]>`SELECT r.id FROM control.runs r JOIN audit.events e ON e.run_id=r.id AND e.kind='sql.execute'
        WHERE r.invocation_deployment_id=${deployment}`;
      if (row) return row.id;
      await Bun.sleep(10);
    }
    throw Error("function did not make its real API callback");
  }
  const callbackSource = `const headers={authorization:'Bearer '+props.token,'x-backplane-run':props.runId,'content-type':'application/json'};
    const api='http://server:3000/api/v1/workspaces/'+props.workspaceId;
    const write=await fetch(api+'/sql',{method:'POST',headers,body:JSON.stringify({statement:'INSERT INTO runtime_proof (id,value) VALUES ($1,$2) RETURNING principal_id,run_id',params:[props.runId,props.token]})});
    if(write.status!==200)throw Error('callback failed'); const stamped=await write.json();`;
  return { pool, app, base, workspaceId, callerId, callerRun, ownerId, ownerRun, ownerKey, headers, userHeaders, post, deploy, observed, callbackSource,
    start, async crash() { server!.kill("SIGKILL"); await server!.exited; },
    async close() { if (server && server.exitCode === null) { server.kill("SIGTERM"); await server.exited; } await pool.close(); await cleanupFixtures(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) {
    if (server && server.exitCode === null) { server.kill("SIGKILL"); await server.exited; }
    await pool.close(); await cleanupFixtures(); await rm(directory, { recursive: true, force: true }); throw error;
  }
}
