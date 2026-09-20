// Real database/API scenarios with HTTP identity fixtures; workerd execution has a separate acceptance gate.
import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { createRun, issueKey, principalFixture, testApp } from "../testing/session.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { createComputeLauncher } from "./compute-launcher.ts";
import { readControlSurfaceHash, type ArtifactEvidence } from "./runtime-identity.ts";

test("artifact changes preserve stored config hashes; activation verifies before taking the Workspace cursor", async () => {
  const pool = createPool(await migratedDatabase(), 1);
  const runtimeDigest = "workerd-binary-sha256:" + "a".repeat(64), control = await readControlSurfaceHash();
  const artifacts: ArtifactEvidence[] = [
    { source: "host-declared", reference: "fixture:first", hostObservedImageId: "sha256:" + "b".repeat(64) },
    { source: "host-declared", reference: "fixture:second", hostObservedImageId: null },
  ];
  const paths: string[][] = [[], []];
  const dispatched: (string | null)[][] = [];
  let observedControl = control;
  let rejectDispatch = false;
  let hold: Promise<void> | undefined;
  let identityStarted: (() => void) | undefined;
  let release: (() => void) | undefined;
  const servers = artifacts.map((artifact, index) => Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    paths[index]?.push(path);
    if (path === "/identity") {
      identityStarted?.();
      await hold;
      return new Response(null, { status: 204, headers: { "x-backplane-runtime": runtimeDigest,
        "x-backplane-control": observedControl, "x-backplane-artifact": JSON.stringify(artifact) } });
    }
    dispatched.push([path, request.headers.get("x-backplane-runtime"), request.headers.get("x-backplane-control"), request.headers.get("x-backplane-artifact")]);
    if (rejectDispatch) return new Response(null, { status: 503, headers: { "x-backplane-error": "compute_unavailable" } });
    return path === "/prepare" ? new Response(null, { status: 204 }) : Response.json({ ok: true });
  } }));
  try {
    const fixture = await principalFixture(pool);
    const { workspaceId, principalId, cookie } = fixture;
    const key = await issueKey(fixture.app, cookie, workspaceId, principalId);
    const runId = await createRun(fixture.app, key, workspaceId);
    const apps = await Promise.all(servers.map(server => testApp(pool, { compute: createComputeLauncher({
      url: server.url.href, token: "fixture", runtimeDigest, timeoutMs: "60000" }) })));
    const first = apps[0]!, second = apps[1]!;
    const base = `http://localhost/api/v1/workspaces/${workspaceId}/functions/identity`;
    const headers = { authorization: `Bearer ${key}`, "x-backplane-run": runId, "content-type": "application/json" };
    const post = (app: typeof first, path: string, body: unknown) => app.handle(new Request(base + path, { method: "POST", headers, body: JSON.stringify(body) }));
    const input = { id: crypto.randomUUID(), bundle: 'export default { fetch() { return Response.json({ok:true}); } };', entryPoint: "default", outboundUrls: [] };
    expect((await post(first, "/deployments", input)).status).toBe(201);
    const original = await pool`SELECT * FROM control.deployments WHERE workspace_id = ${workspaceId} AND id = ${input.id}`;
    expect((await post(second, "/deployments", input)).status).toBe(200);
    expect(await pool`SELECT * FROM control.deployments WHERE workspace_id = ${workspaceId} AND id = ${input.id}`).toEqual(original);
    const nextId = crypto.randomUUID();
    expect((await post(second, "/deployments", { ...input, id: nextId })).status).toBe(201);
    const rows = await pool<{ config_hash: string }[]>`SELECT encode(config_hash, 'hex') AS config_hash FROM control.deployments WHERE workspace_id = ${workspaceId}`;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.config_hash).toBe(rows[1]?.config_hash);
    expect(await pool<{ artifact: ArtifactEvidence }[]>`SELECT metadata->'artifact' AS artifact FROM audit.events WHERE workspace_id = ${workspaceId} AND kind = 'function.deploy' ORDER BY position`)
      .toEqual(artifacts.map(artifact => ({ artifact })));
    hold = new Promise(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { identityStarted = resolve; });
    const activation = post(second, `/deployments/${nextId}/activate`, { expectedActiveId: null });
    await started;
    // A concurrent stamped transaction must finish while the identity response is still withheld.
    await withRunContext(pool, { workspaceId, principalId, runId }, async tx => { await tx`SELECT 1`; });
    release?.(); hold = undefined; identityStarted = undefined;
    expect((await activation).status).toBe(200);
    expect((await post(second, "/invoke", { input: null })).status).toBe(200);
    expect(paths).toEqual([["/identity"], ["/identity", "/identity", "/identity", "/prepare", "/identity", "/invoke"]]);
    expect(await pool`SELECT * FROM control.deployments WHERE workspace_id = ${workspaceId} AND id = ${input.id}`).toEqual(original);

    // Identity admission succeeds, but the runtime refuses the observation on dispatch.
    rejectDispatch = true;
    for (const [path, body] of [[`/deployments/${input.id}/activate`, { expectedActiveId: nextId }], ["/invoke", { input: null }]] as const) {
      const response = await post(second, path, body);
      expect([response.status, await response.json()]).toEqual([503, { error: "compute_unavailable" }]);
    }
    rejectDispatch = false;
    expect(await pool`SELECT * FROM control.deployments WHERE workspace_id = ${workspaceId} AND id = ${input.id}`).toEqual(original);
    expect(await pool<{ run_id: string }[]>`SELECT t.run_id FROM control.invocation_tokens t JOIN control.runs r ON r.id = t.run_id WHERE r.workspace_id = ${workspaceId}`).toEqual([]);

    // A hung identity endpoint retains the 2s budget even when invocation permits 60s.
    for (const [path, body] of [["/deployments", { ...input, id: crypto.randomUUID() }],
      [`/deployments/${nextId}/activate`, { expectedActiveId: nextId }], ["/invoke", { input: null }]] as const) {
      hold = new Promise(resolve => { release = resolve; });
      const before = performance.now();
      const response = await post(second, path, body);
      expect([response.status, await response.json()]).toEqual([503, { error: "compute_unavailable" }]);
      expect(performance.now() - before).toBeLessThan(4500);
      release?.(); hold = undefined;
    }
    observedControl = "0".repeat(64);
    for (const [path, body] of [["/deployments", { ...input, id: crypto.randomUUID() }],
      [`/deployments/${nextId}/activate`, { expectedActiveId: nextId }], ["/invoke", { input: null }]] as const) {
      const response = await post(second, path, body);
      expect([response.status, await response.json()]).toEqual([503, { error: "compute_unavailable" }]);
    }
    expect(paths[1]?.filter(path => path !== "/identity")).toEqual(["/prepare", "/invoke", "/prepare", "/invoke"]);
    expect(dispatched).toEqual(["/prepare", "/invoke", "/prepare", "/invoke"].map(path =>
      [path, runtimeDigest, control, JSON.stringify(artifacts[1])]));
    expect(await pool<{ kind: string; reason: string; principal_id: string; run_id: string }[]>`SELECT kind, reason, principal_id, run_id FROM audit.rejections WHERE workspace_id = ${workspaceId} ORDER BY id`)
      .toEqual(["function.activate", "function.invoke", "function.deploy", "function.activate", "function.invoke", "function.deploy", "function.activate", "function.invoke"].map(kind => ({ kind, reason: "compute_unavailable", principal_id: principalId, run_id: runId })));
  } finally { release?.(); await Promise.all(servers.map(server => server.stop(true))); await pool.close(); }
}, 15000);
