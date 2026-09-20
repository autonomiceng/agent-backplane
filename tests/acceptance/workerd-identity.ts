// Explicit PG gate against a separately owned runtime. No Docker or installed-stack mutations here.
import { expect, test } from "bun:test";
import { createComputeLauncher } from "../../apps/server/compute/compute-launcher.ts";
import { createPool } from "../../apps/server/platform/pool.ts";
import { migratedDatabase } from "../../apps/server/testing/postgres.ts";
import { createRun, issueKey, principalFixture, testApp } from "../../apps/server/testing/session.ts";

test("effective runtime identity preserves deployer authority and refuses a wrong expectation before registration", async () => {
  const compute = createComputeLauncher({ url: Bun.env.BP_COMPUTE_URL, token: Bun.env.BP_COMPUTE_TOKEN, runtimeDigest: Bun.env.BP_WORKERD_RUNTIME_ID });
  if (!compute) throw Error("owned runtime BP_COMPUTE_URL, BP_COMPUTE_TOKEN and BP_WORKERD_RUNTIME_ID required");
  const evidence = await compute.verify(AbortSignal.timeout(5000));
  if (!evidence) throw Error("owned runtime identity verification failed");
  const { artifact } = evidence;
  const pool = createPool(await migratedDatabase());
  let listener: Bun.Server<undefined> | undefined;
  try {
    const fixture = await principalFixture(pool);
    const { workspaceId, principalId, cookie } = fixture;
    const key = await issueKey(fixture.app, cookie, workspaceId, principalId);
    const runId = await createRun(fixture.app, key, workspaceId);
    const app = await testApp(pool, { compute });
    const url = `http://localhost/api/v1/workspaces/${workspaceId}/functions/identity/deployments`;
    const headers = { authorization: `Bearer ${key}`, "x-backplane-run": runId, "content-type": "application/json" };
    const input = { id: crypto.randomUUID(), bundle: 'export default { fetch() { return Response.json({ok:true}); } };', entryPoint: "default", outboundUrls: [] };
    const post = (target: typeof app, path: string, body: unknown) => target.handle(new Request(path, { method: "POST", headers, body: JSON.stringify(body) }));
    const response = await post(app, url, input);
    expect(response.status).toBe(201);
    const metadata = await response.json();
    expect(metadata).not.toHaveProperty("artifact");
    expect(metadata).toMatchObject({ principalId, runId, runtimeDigest: compute.runtimeDigest });
    expect((await post(app, `${url}/${input.id}/activate`, { expectedActiveId: null })).status).toBe(200);
    const wrong = createComputeLauncher({ url: Bun.env.BP_COMPUTE_URL, token: Bun.env.BP_COMPUTE_TOKEN,
      runtimeDigest: "workerd-binary-sha256:" + "0".repeat(64) });
    if (!wrong) throw Error("launcher missing");
    const badApp = await testApp(pool, { compute: wrong });
    const refusedId = crypto.randomUUID();
    listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => badApp.handle(request) });
    const refused = await fetch(new URL(new URL(url).pathname, listener.url), { method: "POST", headers,
      body: JSON.stringify({ ...input, id: refusedId }), signal: AbortSignal.timeout(5000) });
    expect([refused.status, await refused.json()]).toEqual([503, { error: "compute_unavailable" }]);
    const ready = await fetch(new URL("/health/ready", listener.url), { signal: AbortSignal.timeout(5000) });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: "ready" });
    const whoami = await fetch(new URL(`/api/v1/workspaces/${workspaceId}/whoami`, listener.url), { headers, signal: AbortSignal.timeout(5000) });
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toEqual({ workspaceId, principalId });
    expect((await post(badApp, `${url}/${input.id}/activate`, { expectedActiveId: input.id })).status).toBe(503);
    expect(await pool<{ kind: string; reason: string; principal_id: string; run_id: string }[]>`SELECT kind, reason, principal_id, run_id FROM audit.rejections WHERE workspace_id = ${workspaceId} ORDER BY id`)
      .toEqual(["function.deploy", "function.activate"].map(kind => ({ kind, reason: "compute_unavailable", principal_id: principalId, run_id: runId })));
    expect(await pool<{ id: string }[]>`SELECT id FROM control.deployments WHERE workspace_id = ${workspaceId} AND id = ${refusedId}`).toEqual([]);
    expect(await pool<{ principal_id: string; run_id: string; runtime_digest: string; config_hash: string }[]>`SELECT principal_id, run_id, runtime_digest, encode(config_hash, 'hex') AS config_hash
      FROM control.deployments WHERE workspace_id = ${workspaceId} AND id = ${input.id}`)
      .toEqual([{ principal_id: principalId, run_id: runId, runtime_digest: compute.runtimeDigest, config_hash: metadata.configHash }]);
    expect(await pool<{ kind: string; principal_id: string; run_id: string; artifact: typeof artifact }[]>`SELECT kind, principal_id, run_id, metadata->'artifact' AS artifact FROM audit.events WHERE workspace_id = ${workspaceId} AND kind LIKE 'function.%' ORDER BY position`)
      .toEqual([{ kind: "function.deploy", principal_id: principalId, run_id: runId, artifact }, { kind: "function.activate", principal_id: principalId, run_id: runId, artifact }]);
    expect((await post(app, `${url}/${input.id}/activate`, { expectedActiveId: input.id })).status).toBe(200);
    const invoked = await post(app, url.replace(/\/deployments$/, "/invoke"), { input: null });
    expect(invoked.status).toBe(200);
    const result = await invoked.json();
    expect(result).toMatchObject({ deploymentId: input.id, result: { ok: true } });
    expect(result.runId).not.toBe(runId);
    expect(await pool<{ parent_run_id: string; invocation_deployment_id: string }[]>`SELECT parent_run_id, invocation_deployment_id FROM control.runs WHERE workspace_id = ${workspaceId} AND id = ${result.runId}`)
      .toEqual([{ parent_run_id: runId, invocation_deployment_id: input.id }]);
    expect(await pool<{ principal_id: string; run_id: string; child_run_id: string; artifact: typeof artifact }[]>`SELECT principal_id, run_id, metadata->>'runId' AS child_run_id, metadata->'artifact' AS artifact
      FROM audit.events WHERE workspace_id = ${workspaceId} AND kind = 'function.invoke'`).toEqual([{ principal_id: principalId, run_id: runId, child_run_id: result.runId, artifact }]);
  } finally { await listener?.stop(true); await pool.close(); }
}, 30000);
