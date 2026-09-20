// Two real-Postgres scenarios cover attribution and the optional profile boundary.
import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { testApp, createRun, issueKey, principalFixture } from "../testing/session.ts";
import { createComputeLauncher, type ComputeLauncher } from "./compute-launcher.ts";
import type { Manifest } from "./deployment-config.ts";

test("deployment and activation attribute the wrong Principal, Run or User", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const fixture = await principalFixture(pool);
    const { cookie, workspaceId, principalId } = fixture;
    const key = await issueKey(fixture.app, cookie, workspaceId, principalId);
    const runId = await createRun(fixture.app, key, workspaceId);
    const activationRun = await createRun(fixture.app, key, workspaceId);
    const prepared: Manifest[] = [];
    const compute: ComputeLauncher = { async verify() { return { source: "host-declared", reference: "fixture:local", hostObservedImageId: null }; }, runtimeDigest: "workerd-binary-sha256:" + "a".repeat(64), async prepare(manifest) { prepared.push(manifest); return { ok: true, value: { source: "host-declared", reference: "fixture:local", hostObservedImageId: null } }; } };
    const app = await testApp(pool, { compute });
    const base = `http://localhost/api/v1/workspaces/${workspaceId}`;
    const path = `${base}/functions/example/deployments`;
    const headers = { authorization: `Bearer ${key}`, "x-backplane-run": runId, "content-type": "application/json" };
    const userHeaders = { origin: "http://localhost", cookie, "content-type": "application/json" };
    const post = (url: string, body: unknown, actorHeaders: Record<string, string> = headers) => app.handle(new Request(url, {
      method: "POST", headers: actorHeaders, body: JSON.stringify(body),
    }));
    const input = { id: crypto.randomUUID(), bundle: 'export default { fetch() { return new Response("hello"); } };',
      entryPoint: "default", outboundUrls: ["https://example.com/"] };
    const registered = await post(path, input);
    expect(registered.status).toBe(201);
    const metadata = await registered.json();
    expect(metadata).toMatchObject({ id: input.id, principalId, runId, status: "registered" });
    expect(metadata).not.toHaveProperty("bundle");
    expect((await post(path, input)).status).toBe(200);
    expect(prepared).toHaveLength(0);

    const other = await post(`${base}/principals`, { name: "Other" }, userHeaders);
    expect(other.status).toBe(201);
    const otherId = (await other.json()).id as string;
    const otherKey = await issueKey(app, cookie, workspaceId, otherId);
    const otherRun = await createRun(app, otherKey, workspaceId);
    const otherHeaders = { ...headers, authorization: `Bearer ${otherKey}`, "x-backplane-run": otherRun };
    const foreignRun = await post(path, { ...input, id: crypto.randomUUID() }, { ...headers, "x-backplane-run": otherRun });
    expect([foreignRun.status, await foreignRun.json()]).toEqual([403, { error: "run_forbidden" }]);
    const foreignOwner = await post(path, { ...input, id: crypto.randomUUID() }, otherHeaders);
    expect([foreignOwner.status, await foreignOwner.json()]).toEqual([403, { error: "function_forbidden" }]);
    const userDeploy = await post(path, { ...input, id: crypto.randomUUID() }, userHeaders);
    expect([userDeploy.status, await userDeploy.json()]).toEqual([401, { error: "unauthorized" }]);
    const foreignActivation = await post(`${path}/${input.id}/activate`, { expectedActiveId: null }, otherHeaders);
    expect([foreignActivation.status, await foreignActivation.json()]).toEqual([403, { error: "function_forbidden" }]);
    expect(await pool<{ kind: string; principal_id: string | null; run_id: string | null; user_id: string | null }[]>`SELECT kind, principal_id, run_id, user_id FROM audit.events WHERE kind LIKE 'function.%'`)
      .toEqual([{ kind: "function.deploy", principal_id: principalId, run_id: runId, user_id: null }]);
    expect(await pool<{ reason: string }[]>`SELECT reason FROM audit.rejections WHERE kind LIKE 'function.%' ORDER BY id`)
      .toEqual([{ reason: "function_forbidden" }, { reason: "function_forbidden" }]);

    const activated = await post(`${path}/${input.id}/activate`, { expectedActiveId: null }, { ...headers, "x-backplane-run": activationRun });
    expect(activated.status).toBe(200);
    expect(await activated.json()).toMatchObject({ status: "active", principalId, runId });
    expect((await post(`${path}/${input.id}/activate`, { expectedActiveId: null })).status).toBe(200);
    expect(prepared[0]).toMatchObject({ id: input.id, bundle: input.bundle, configHash: metadata.configHash,
      bundleSha256: metadata.bundleSha256, keyRef: { workspaceId, principalId } });
    const next = { ...input, id: crypto.randomUUID(), bundle: 'export default { fetch() { return new Response("next"); } };' };
    expect((await post(path, next)).status).toBe(201);
    const userActivation = await post(`${path}/${next.id}/activate`, { expectedActiveId: input.id }, userHeaders);
    expect(userActivation.status).toBe(200);
    expect(await userActivation.json()).toMatchObject({ id: next.id, status: "active", principalId, runId });
    const read = await app.handle(new Request(`${path}/${next.id}`, { headers: { cookie } }));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ id: next.id, status: "active", principalId, runId });
    const [user] = await pool`SELECT id FROM control."user" WHERE email = 'credentials@example.com'`;
    expect(await pool<{ principal_id: string; run_id: string }[]>`SELECT principal_id, run_id FROM control.functions WHERE workspace_id = ${workspaceId}`)
      .toEqual([{ principal_id: principalId, run_id: runId }]);
    expect(await pool<{ id: string; principal_id: string; run_id: string; status: string }[]>`SELECT id, principal_id, run_id, status FROM control.deployments WHERE workspace_id = ${workspaceId} ORDER BY created_at`)
      .toEqual([{ id: input.id, principal_id: principalId, run_id: runId, status: "retired" },
        { id: next.id, principal_id: principalId, run_id: runId, status: "active" }]);
    expect(await pool<{ kind: string; principal_id: string | null; run_id: string | null; user_id: string | null }[]>`SELECT kind, principal_id, run_id, user_id FROM audit.events WHERE kind LIKE 'function.%' ORDER BY position`)
      .toEqual([{ kind: "function.deploy", principal_id: principalId, run_id: runId, user_id: null },
        { kind: "function.activate", principal_id: principalId, run_id: activationRun, user_id: null },
        { kind: "function.deploy", principal_id: principalId, run_id: runId, user_id: null },
        { kind: "function.activate", principal_id: null, run_id: null, user_id: user.id }]);
  } finally { await pool.close(); }
});

test("disabled compute reaches authentication or breaks core readiness", async () => {
  const previousUrl = Bun.env.BP_COMPUTE_URL;
  delete Bun.env.BP_COMPUTE_URL;
  const pool = createPool(await migratedDatabase());
  try {
    const { app, workspaceId } = await principalFixture(pool);
    expect(createComputeLauncher({ url: Bun.env.BP_COMPUTE_URL, token: undefined, runtimeDigest: undefined })).toBeUndefined();
    const path = `http://localhost/api/v1/workspaces/${workspaceId}/functions/example/deployments`;
    const deployed = await app.handle(new Request(path, { method: "POST", body: "invalid JSON" }));
    expect([deployed.status, await deployed.json()]).toEqual([503, { error: "compute_disabled" }]);
    const activated = await app.handle(new Request(`${path}/${crypto.randomUUID()}/activate`, { method: "POST" }));
    expect([activated.status, await activated.json()]).toEqual([503, { error: "compute_disabled" }]);
    const read = await app.handle(new Request(`${path}/${crypto.randomUUID()}`));
    expect([read.status, await read.json()]).toEqual([503, { error: "compute_disabled" }]);
    expect(await pool<{ id: string }[]>`SELECT id FROM control.deployments`).toEqual([]);
    expect(await pool<{ kind: string }[]>`SELECT kind FROM audit.events WHERE kind LIKE 'function.%'`).toEqual([]);
    const ready = await app.handle(new Request("http://localhost/health/ready"));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: "ready", problems: [] });
  } finally {
    await pool.close();
    if (previousUrl === undefined) delete Bun.env.BP_COMPUTE_URL; else Bun.env.BP_COMPUTE_URL = previousUrl;
  }
});
