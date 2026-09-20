// Three real-Postgres scenarios use an authenticated fake workerd endpoint that never evaluates bundle text.
import { SQL } from "bun";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { principalSession } from "../auth/principal-session.ts";
import type { Claim } from "../queue/claim-input.ts";
import { createPool } from "../platform/pool.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { testApp, applyMigration, createRun, issueKey, principalFixture } from "../testing/session.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { reconcileInvocations } from "./reconcile-invocations.ts";
import { finishInvocation } from "./finish-invocation.ts";
import type { ComputeLauncher, Invocation } from "./compute-launcher.ts";

async function fixture() {
  const database = await migratedDatabase(), pool = createPool(database);
  try {
    const initial = await principalFixture(pool);
    const { cookie, workspaceId, principalId: callerId } = initial;
    const callerKey = await issueKey(initial.app, cookie, workspaceId, callerId);
    const callerRun = await createRun(initial.app, callerKey, workspaceId);
    const userHeaders = { origin: "http://localhost", cookie, "content-type": "application/json" };
    const base = `http://localhost/api/v1/workspaces/${workspaceId}`;
    const ownerResponse = await initial.app.handle(new Request(`${base}/principals`, {
      method: "POST", headers: userHeaders, body: JSON.stringify({ name: "Function" }),
    }));
    expect(ownerResponse.status).toBe(201);
    const ownerId = (await ownerResponse.json()).id as string;
    const ownerKey = await issueKey(initial.app, cookie, workspaceId, ownerId);
    const ownerRun = await createRun(initial.app, ownerKey, workspaceId);
    const scripts = new Map<string, (value: Invocation, signal: AbortSignal) => Promise<Response>>();
    const observed: Invocation[] = [];
    const transportToken = "fake-workerd-transport";
    const endpoint = async (request: Request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${transportToken}`);
      expect(new URL(request.url).pathname).toBe("/invoke");
      const value = await request.json() as Invocation;
      observed.push(value);
      const script = scripts.get(value.manifest.id);
      if (!script) throw new Error("unknown test deployment");
      return script(value, request.signal);
    };
    const compute: ComputeLauncher = { async verify() { return { runtimeDigest: "workerd-binary-sha256:" + "a".repeat(64), controlHash: "b".repeat(64), artifact: { source: "host-declared", reference: "fixture:local", hostObservedImageId: null } }; }, runtimeDigest: "workerd-binary-sha256:" + "a".repeat(64),
      async prepare() { return { ok: true, value: { source: "host-declared", reference: "fixture:local", hostObservedImageId: null } }; },
      invoke(value, signal) { return endpoint(new Request("http://workerd.invalid/invoke", {
        method: "POST", headers: { authorization: `Bearer ${transportToken}`, "content-type": "application/json" },
        body: JSON.stringify(value), signal,
      })); },
    };
    const blobBytes = new Map<string, Uint8Array>();
    const blobStore = {
      async stage(w: string, id: string, bytes: Uint8Array) { blobBytes.set(`${w}/${id}`, bytes); },
      async promote(w: string, id: string, bytes: Uint8Array) { blobBytes.set(`${w}/${id}`, bytes); },
      async open(w: string, id: string) { const bytes = blobBytes.get(`${w}/${id}`); if (!bytes) throw new Error("missing"); return bytes; },
      async remove(w: string, ref: { id: string; staging: boolean }) { if (!ref.staging) blobBytes.delete(`${w}/${ref.id}`); },
      async scanPage() { return []; },
    };
    const releaseOrdinary = Promise.withResolvers<void>();
    let ordinaryEntered = 0;
    const app = (await testApp(pool, { compute, blobStore }))
      .use(principalSession(pool)).post("/api/v1/workspaces/:workspaceId/admission-hold", async () => {
        ordinaryEntered++; await releaseOrdinary.promise; return null;
      }, { principal: true, detail: { hide: true } });
    const headers = (token: string, runId: string) => ({ authorization: `Bearer ${token}`, "x-backplane-run": runId, "content-type": "application/json" });
    const post = (path: string, body: unknown, actor: Record<string, string> = headers(callerKey, callerRun), signal?: AbortSignal) => app.handle(new Request(`${base}${path}`, {
      method: "POST", headers: actor, body: JSON.stringify(body), ...(signal ? { signal } : {}),
    }));
    const deploy = async (name: string, script: (value: Invocation, signal: AbortSignal) => Promise<Response>) => {
      const id: string = crypto.randomUUID();
      scripts.set(id, script);
      expect((await post(`/functions/${name}/deployments`, { id, bundle: "export default { fetch() {} };", entryPoint: "default", outboundUrls: [] }, headers(ownerKey, ownerRun))).status).toBe(201);
      expect((await post(`/functions/${name}/deployments/${id}/activate`, { expectedActiveId: null }, headers(ownerKey, ownerRun))).status).toBe(200);
      return id;
    };
    const callback = (value: Invocation, path = "/sql", body: unknown = { statement: "SELECT 1 AS value", params: [] }) =>
      post(path, body, headers(value.props.token, value.props.runId));
    return { database, pool, app, base, workspaceId, callerId, callerKey, callerRun, ownerId, ownerKey, ownerRun,
      headers, userHeaders, compute, post, deploy, callback, observed,
      ordinary: { get entered() { return ordinaryEntered; }, release: () => releaseOrdinary.resolve() } };
  } catch (error) { await pool.close(); throw error; }
}
async function denied(response: Response, status: number, error: string) {
  expect([response.status, await response.json()]).toEqual([status, { error }]);
}

test("invocation credentials escape their Run, Workspace, operation scope or lifetime", async () => {
  const f = await fixture();
  try {
    expect((await f.app.handle(new Request(`${f.base}/reconciliations/delegations/${f.ownerId}`, {
      method: "PUT", headers: f.userHeaders, body: JSON.stringify({ enabled: true }),
    }))).status).toBe(200);
    const deploymentId = await f.deploy("escape", async (value) => {
      expect(Object.keys(value.props).sort()).toEqual(["runId", "token", "workspaceId"]);
      expect(value.props.token).toMatch(/^bp_i_[0-9a-f]{64}$/);
      expect(JSON.stringify(value)).not.toContain(f.callerKey);
      expect(JSON.stringify(value)).not.toContain(f.ownerKey);
      const [stored] = await f.pool`SELECT encode(token_hash,'hex') AS hash FROM control.invocation_tokens WHERE run_id=${value.props.runId}`;
      expect(stored.hash).toBe(createHash("sha256").update(value.props.token).digest("hex"));
      await denied(await f.post("/sql", { statement: "SELECT 1", params: [] }, f.headers(value.props.token, f.ownerRun)), 403, "run_forbidden");
      await denied(await f.app.handle(new Request(`http://localhost/api/v1/workspaces/${crypto.randomUUID()}/blobs/${crypto.randomUUID()}`,
        { headers: f.headers(value.props.token, value.props.runId) })), 403, "workspace_forbidden");
      await denied(await f.app.handle(new Request(`${f.base}/blobs/${crypto.randomUUID()}`,
        { headers: f.headers(value.props.token, f.ownerRun) })), 403, "run_forbidden");
      await denied(await f.app.handle(new Request(`${f.base}/blobs/${crypto.randomUUID()}`,
        { headers: { authorization: `Bearer ${value.props.token}` } })), 403, "run_forbidden");
      await denied(await f.callback(value, "/runs", {}), 403, "invocation_scope_forbidden");
      await denied(await f.callback(value, "/functions/escape/invoke", { input: null }), 403, "invocation_scope_forbidden");
      await denied(await f.app.handle(new Request(`${f.base}/events`, { headers: f.headers(value.props.token, value.props.runId) })), 403, "invocation_scope_forbidden");
      await denied(await f.post("/principals", { name: "Escape" }, { ...f.userHeaders, authorization: `Bearer ${value.props.token}` }), 403, "invocation_scope_forbidden");
      const takeover = await f.post("/sql", { statement: "SELECT 1", params: [] }, f.headers(f.ownerKey, value.props.runId));
      expect(takeover.status).not.toBe(200);
      await expect(withRunContext(f.pool, { workspaceId: f.workspaceId, principalId: f.ownerId, runId: value.props.runId }, async () => {})).rejects.toThrow("unauthorized");
      await expect(withRunContext(f.pool, { workspaceId: f.workspaceId, principalId: f.callerId, runId: f.callerRun }, async (tx) => {
        await tx`INSERT INTO control.runs(id,workspace_id,principal_id,parent_run_id,invocation_deployment_id)
          VALUES(${crypto.randomUUID()},${f.workspaceId},${f.ownerId},${f.callerRun},${value.manifest.id})`;
      })).rejects.toThrow("invocation_scope_forbidden");
      expect((await f.callback(value)).status).toBe(200);
      await applyMigration(f.app, value.props.token, value.props.runId, f.workspaceId, "CREATE TABLE invocation_scope_rows (id integer PRIMARY KEY)");
      const migrations = await f.app.handle(new Request(`${f.base}/migrations`, { headers: f.headers(value.props.token, value.props.runId) }));
      expect(migrations.status).toBe(200);
      expect(await migrations.json()).toMatchObject({ currentRevision: 1, migrations: [{ appliedBy: f.ownerId, runId: value.props.runId }] });
      const transaction = await f.callback(value, "/transactions", { idempotencyKey: "invocation-scope", operations: [
        { sql: { statement: "INSERT INTO invocation_scope_rows (id) VALUES (1)", params: [] } },
      ] });
      expect(transaction.status).toBe(200);
      expect(await transaction.json()).toMatchObject({ committed: true });
      expect((await f.callback(value, "/queues", { name: "invocation-scope" })).status).toBe(201);
      const claimed = async (key: string) => {
        const sent = await f.callback(value, "/queues/invocation-scope/messages", { idempotencyKey: key, payload: { key } });
        expect(sent.status).toBe(201);
        const messageId = (await sent.json()).id as string;
        const message = await f.app.handle(new Request(`${f.base}/queues/invocation-scope/messages/${messageId}`, { headers: f.headers(value.props.token, value.props.runId) }));
        expect(message.status).toBe(200);
        const response = await f.callback(value, "/queues/invocation-scope/claim", {});
        expect(response.status).toBe(200);
        const claim = await response.json() as Claim;
        expect(claim.messageId).toBe(messageId);
        return claim;
      };
      const ack = await claimed("ack");
      expect((await f.callback(value, `/deliveries/${ack.deliveryId}/renew`, { receipt: ack.receipt })).status).toBe(200);
      expect((await f.callback(value, `/deliveries/${ack.deliveryId}/ack`, { receipt: ack.receipt })).status).toBe(200);
      const hold = await claimed("hold");
      expect((await f.callback(value, `/deliveries/${hold.deliveryId}/hold`, { receipt: hold.receipt })).status).toBe(200);
      const effect = await claimed("effect");
      expect((await f.callback(value, `/deliveries/${effect.deliveryId}/begin-effect`, {
        receipt: effect.receipt, action: "submit", destination: "invocation-test",
      })).status).toBe(200);
      const nacked = await f.callback(value, `/deliveries/${effect.deliveryId}/nack`, { receipt: effect.receipt });
      expect(nacked.status).toBe(200);
      expect(await nacked.json()).toMatchObject({ state: "ambiguous" });
      const reconciled = await f.callback(value, "/reconciliations", { deliveryId: effect.deliveryId, outcome: "applied", evidence: "completed by test" });
      expect(reconciled.status).toBe(200);
      expect(await reconciled.json()).toMatchObject({ outcome: "applied" });
      expect((await f.callback(value, "/queues/invocation-scope/recover", {})).status).toBe(200);
      expect((await f.app.handle(new Request(`${f.base}/queues/invocation-scope/deliveries`, { headers: f.headers(value.props.token, value.props.runId) }))).status).toBe(200);
      const blob = await f.app.handle(new Request(`${f.base}/blobs?key=invocation`, { method: "POST",
        headers: { ...f.headers(value.props.token, value.props.runId), "content-type": "application/octet-stream" }, body: "bytes" }));
      expect(blob.status).toBe(201);
      const blobId = (await blob.json()).id as string;
      const read = await f.app.handle(new Request(`${f.base}/blobs/${blobId}`, { headers: f.headers(value.props.token, value.props.runId) }));
      expect([read.status, await read.text()]).toEqual([200, "bytes"]);
      expect((await f.app.handle(new Request(`${f.base}/blobs/${blobId}`, { method: "DELETE", headers: f.headers(value.props.token, value.props.runId) }))).status).toBe(204);
      return Response.json({ accepted: true });
    });
    expect((await f.post("/functions/escape/invoke", { input: null })).status).toBe(200);
    const first = f.observed[0]!;
    await denied(await f.callback(first), 401, "unauthorized");
    expect(await f.pool<{ run_id: string }[]>`SELECT run_id FROM control.invocation_tokens`).toEqual([]);
    await f.deploy("revoke", async (value) => {
      const revoked = await f.post(`/principals/${f.ownerId}/revoke`, {}, f.userHeaders);
      expect(revoked.status).toBe(200);
      await denied(await f.callback(value), 401, "unauthorized");
      return Response.json(null);
    });
    expect((await f.post("/functions/revoke/invoke", { input: null })).status).toBe(200);
    const [terminal] = await f.pool`SELECT principal_id FROM audit.events WHERE run_id=${f.observed[1]!.props.runId} AND kind='function.complete'`;
    expect(terminal.principal_id).toBe(f.ownerId);
    await denied(await f.post("/functions/escape/invoke", { input: null }), 404, "function_not_found");
    expect(deploymentId).toBe(first.manifest.id);
  } finally { await f.pool.close(); }
}, 20000);

test("concurrent invocations stamp the caller or cross credentials and starve callbacks", async () => {
  const f = await fixture();
  try {
    await applyMigration(f.app, f.ownerKey, f.ownerRun, f.workspaceId, "CREATE TABLE invocation_rows (id uuid PRIMARY KEY)");
    const allStarted = Promise.withResolvers<void>();
    const id = await f.deploy("attribution", async (value) => {
      if (f.observed.length === 5) allStarted.resolve();
      await allStarted.promise;
      const other = f.observed.find((v) => v.props.runId !== value.props.runId)!;
      await denied(await f.post("/sql", { statement: "SELECT 1", params: [] }, f.headers(value.props.token, other.props.runId)), 403, "run_forbidden");
      const inserted = await f.callback(value, "/sql", { statement: "INSERT INTO invocation_rows (id) VALUES ($1) RETURNING principal_id, run_id", params: [value.props.runId] });
      expect(inserted.status).toBe(200);
      expect((await inserted.json()).rows).toEqual([{ principal_id: f.ownerId, run_id: value.props.runId }]);
      return Response.json({ runId: value.props.runId });
    });
    const responses = await Promise.all(Array.from({ length: 6 }, () => f.post("/functions/attribution/invoke", { input: { caller: "test" } })));
    for (const response of responses) {
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ deploymentId: id, runId: body.runId, status: 200, result: { runId: body.runId } });
    }
    expect(new Set(f.observed.map((v) => v.props.token)).size).toBe(6);
    const runs = await f.pool<{ id: string; principal_id: string; parent_run_id: string; invocation_deployment_id: string; metadata: unknown }[]>`SELECT id,principal_id,parent_run_id,invocation_deployment_id,metadata FROM control.runs WHERE invocation_deployment_id=${id}`;
    expect(runs).toHaveLength(6);
    for (const run of runs) {
      expect(run).toMatchObject({ principal_id: f.ownerId, parent_run_id: f.callerRun, invocation_deployment_id: id });
      expect(typeof run.metadata === "string" ? JSON.parse(run.metadata) : run.metadata).toEqual({ callerPrincipalId: f.callerId, callerRunId: f.callerRun, deploymentId: id });
      expect(await f.pool<{ kind: string; principal_id: string; run_id: string }[]>`SELECT kind,principal_id,run_id FROM audit.events WHERE run_id=${run.id} ORDER BY position`)
        .toEqual([{ kind: "sql.execute", principal_id: f.ownerId, run_id: run.id }, { kind: "function.complete", principal_id: f.ownerId, run_id: run.id }]);
    }
    const starts = await f.pool`SELECT principal_id,run_id FROM audit.events WHERE kind='function.invoke'`;
    expect(starts).toHaveLength(6);
    for (const start of starts) expect(start).toEqual({ principal_id: f.callerId, run_id: f.callerRun });
    expect(await f.pool<{ run_id: string }[]>`SELECT run_id FROM control.invocation_tokens`).toEqual([]);
    expect((await f.post("/sql", { statement: "SELECT count(*)::int AS count FROM invocation_rows", params: [] })).status).toBe(200);
    const invoking = Promise.withResolvers<void>(), callbackReady = Promise.withResolvers<void>();
    await f.deploy("ordinary-contention", async (value) => {
      invoking.resolve(); await callbackReady.promise;
      try { expect((await f.callback(value)).status).toBe(200); }
      finally { f.ordinary.release(); }
      return Response.json(null);
    });
    const invocation = f.post("/functions/ordinary-contention/invoke", { input: null });
    await invoking.promise;
    const ordinary = Array.from({ length: 4 }, () => f.post("/admission-hold", {}));
    try {
      const deadline = performance.now() + 1500;
      while (f.ordinary.entered < 4 && performance.now() < deadline) await Bun.sleep(5);
      expect(f.ordinary.entered).toBe(4);
      ordinary.push(f.post("/admission-hold", {}));
      while (f.app.decorator.admission.snapshot().waiters === 0 && f.ordinary.entered === 4 && performance.now() < deadline) await Bun.sleep(5);
      callbackReady.resolve();
      expect((await invocation).status).toBe(200);
    } finally { callbackReady.resolve(); f.ordinary.release(); await invocation; }
    for (const response of await Promise.all(ordinary)) expect(response.status).toBe(200);
  } finally { await f.pool.close(); }
}, 20000);

test("execution, response overflow and failed finalization leave unbounded authority or occupied permits", async () => {
  const f = await fixture();
  try {
    await denied(await f.post("/functions/missing/invoke", { input: null }), 404, "function_not_found");
    await denied(await f.post("/functions/missing/invoke", { input: "x".repeat(1048576) }), 413, "invocation_body_too_large");
    await denied(await f.post("/functions/missing/invoke", { input: null, timeoutMs: 10001 }), 422, "invalid_input");
    let aborted = false, cancelled = false;
    await f.deploy("timeout", async (_value, signal) => {
      signal.addEventListener("abort", () => { aborted = true; });
      return new Promise<Response>(() => {});
    });
    const started = performance.now();
    await denied(await f.post("/functions/timeout/invoke", { input: null, timeoutMs: 200 }), 504, "function_timeout");
    expect(performance.now() - started).toBeLessThan(2500);
    expect(aborted).toBe(true);
    await f.deploy("overflow", async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(65536)); }, cancel() { cancelled = true; },
    })));
    await denied(await f.post("/functions/overflow/invoke", { input: null }), 502, "function_response_too_large");
    expect(cancelled).toBe(true);
    let readerCancelled = false;
    await f.deploy("read-timeout", async () => new Response(new ReadableStream({ cancel() { readerCancelled = true; } })));
    await denied(await f.post("/functions/read-timeout/invoke", { input: null, timeoutMs: 200 }), 504, "function_timeout");
    expect(readerCancelled).toBe(true);
    const client = new AbortController();
    await f.deploy("disconnect", async () => { queueMicrotask(() => client.abort()); return new Promise<Response>(() => {}); });
    await denied(await f.post("/functions/disconnect/invoke", { input: null }, undefined, client.signal), 502, "function_failed");
    await f.deploy("invalid", async () => new Response("not JSON"));
    await denied(await f.post("/functions/invalid/invoke", { input: null }), 502, "function_response_invalid");
    await f.deploy("handler-fail", async () => Response.json({ failed: true }, { status: 418 }));
    const failed = await f.post("/functions/handler-fail/invoke", { input: null });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ status: 418, result: { failed: true } });
    await f.deploy("complete", async () => Response.json(null));
    expect((await f.post("/functions/complete/invoke", { input: null })).status).toBe(200);
    const kinds = ["function.timeout", "function.fail", "function.timeout", "function.fail", "function.fail", "function.fail", "function.complete"];
    for (const [index, value] of f.observed.entries()) {
      expect(await f.pool<{ kind: string }[]>`SELECT kind FROM audit.events WHERE run_id=${value.props.runId} AND kind LIKE 'function.%'`).toEqual([{ kind: kinds[index]! }]);
      await denied(await f.callback(value), 401, "unauthorized");
    }
    await finishInvocation(f.pool, f.observed[0]!.props.runId, "function.complete", 1, 200);
    expect(await f.pool<{ kind: string }[]>`SELECT kind FROM audit.events WHERE run_id=${f.observed[0]!.props.runId}`).toEqual([{ kind: "function.timeout" }]);
    expect(await f.pool<{ run_id: string }[]>`SELECT run_id FROM control.invocation_tokens`).toEqual([]);
    const release = Promise.withResolvers<void>(), locked = Promise.withResolvers<void>();
    let blocker: Promise<void> | undefined;
    await f.deploy("finalize", async () => {
      blocker = withRunContext(f.pool, { workspaceId: f.workspaceId, principalId: f.callerId, runId: f.callerRun }, async () => {
        locked.resolve(); await release.promise;
      });
      await locked.promise;
      const [initial] = await f.pool<{ remaining: number }[]>`SELECT extract(epoch FROM expires_at-clock_timestamp())::float8 AS remaining
        FROM control.invocation_tokens WHERE run_id=${f.observed.at(-1)!.props.runId}`;
      expect(initial?.remaining).toBeGreaterThan(8);
      return Response.json(null);
    });
    const finalizing = f.post("/functions/finalize/invoke", { input: null });
    try {
      await locked.promise;
      const value = f.observed.at(-1)!;
      const deadline = performance.now() + 1500;
      while ((await f.pool<{ run_id: string }[]>`SELECT run_id FROM control.invocation_tokens WHERE run_id=${value.props.runId}`).length
        && performance.now() < deadline) await Bun.sleep(5);
      await denied(await f.callback(value), 401, "unauthorized");
      expect(await f.pool<{ run_id: string }[]>`SELECT run_id FROM control.invocation_tokens WHERE run_id=${value.props.runId}`).toEqual([]);
      release.resolve(); await blocker;
      expect((await finalizing).status).toBe(200);
      await finishInvocation(f.pool, value.props.runId, "function.complete", 1, 200);
      expect(await f.pool<{ kind: string }[]>`SELECT kind FROM audit.events WHERE run_id=${value.props.runId}`).toEqual([{ kind: "function.complete" }]);
    } finally { release.resolve(); await blocker; await finalizing; }
    const exhaustedRelease = Promise.withResolvers<void>();
    let exhaustedBlocker: Promise<void> | undefined;
    await f.deploy("exhausted", async () => {
      const acquired = Promise.withResolvers<void>();
      exhaustedBlocker = withRunContext(f.pool, { workspaceId: f.workspaceId, principalId: f.callerId, runId: f.callerRun }, async () => {
        acquired.resolve(); await exhaustedRelease.promise;
      });
      await acquired.promise;
      return Response.json(null);
    });
    try {
      await denied(await f.post("/functions/exhausted/invoke", { input: null }), 503, "invocation_finalize_failed");
      const value = f.observed.at(-1)!;
      await denied(await f.callback(value), 401, "unauthorized");
      expect(await f.pool<{ run_id: string }[]>`SELECT run_id FROM control.invocation_tokens WHERE run_id=${value.props.runId}`).toEqual([]);
    } finally { exhaustedRelease.resolve(); await exhaustedBlocker; }
    const exhausted = f.observed.at(-1)!;
    expect(await reconcileInvocations(f.pool)).toBe(0);
    const admin = new SQL(adminUrl(f.database));
    try { await admin`UPDATE control.invocation_pending SET expires_at=clock_timestamp()-interval '11 seconds' WHERE run_id=${exhausted.props.runId}`; }
    finally { await admin.close(); }
    await reconcileInvocations(f.pool);
    const repaired = await f.pool<{ kind: string; metadata: unknown }[]>`SELECT kind,metadata FROM audit.events WHERE run_id=${exhausted.props.runId}`;
    expect(repaired).toHaveLength(1); expect(repaired[0]?.kind).toBe("function.fail");
    await finishInvocation(f.pool, exhausted.props.runId, "function.complete", 1, 200);
    expect(await f.pool<{ kind: string; metadata: unknown }[]>`SELECT kind,metadata FROM audit.events WHERE run_id=${exhausted.props.runId}`).toEqual(repaired);
    expect((await f.post("/functions/complete/invoke", { input: null })).status).toBe(200);
    expect(await f.pool<{ run_id: string }[]>`SELECT run_id FROM control.invocation_tokens`).toEqual([]);
    expect((await f.post("/sql", { statement: "SELECT 1", params: [] })).status).toBe(200);
  } finally { await f.pool.close(); }
}, 20000);
