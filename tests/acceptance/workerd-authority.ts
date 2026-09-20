// Three real-PG + actual-runtime cases. Runtime API service must target BP_TEST_API_PORT on this host.
import { expect, test } from "bun:test";
import { workerdPgFixture as fixture } from "./workerd-pg-fixture.ts";
import { reconcileInvocations } from "../../apps/server/compute/reconcile-invocations.ts";
import { withRunContext } from "../../apps/server/runs/with-run-context.ts";

test("real function callbacks retain owner Run and Workspace authority with exact egress and revoked credentials", async () => {
  const f = await fixture();
  try {
    const other = await f.app.handle(new Request("http://localhost/api/v1/workspaces", { method: "POST", headers: f.userHeaders, body: JSON.stringify({ name: "Other" }) }));
    expect(other.status).toBe(201); const otherId: string = (await other.json()).id;
    const urls = ["https://example.com/", "https://127.0.0.1/", "https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com%2F"].sort();
    const id = await f.deploy("authority", `export default {async fetch(r,props){${f.callbackSource}
      const statuses=[];
      for(const url of ${JSON.stringify([...urls, "https://example.com/undeclared", `http://server:3000/api/v1/workspaces/${otherId}/whoami`])}) {
        try {const response=await fetch(url);statuses.push(response.status);await response.body?.cancel();}catch{statuses.push(0)}
      }
      const wrong=await fetch(api+'/sql',{method:'POST',headers:{...headers,'x-backplane-run':${JSON.stringify(f.ownerRun)}},body:JSON.stringify({statement:'SELECT 1',params:[]})});
      return Response.json({stamped,statuses,wrong:wrong.status,token:props.token});}}`, urls);
    const response = await f.post("/functions/authority/invoke", { input: null }); expect(response.status).toBe(200);
    const body = await response.json(); expect(body.status).toBe(200);
    expect(body.result.stamped.rows).toEqual([{ principal_id: f.ownerId, run_id: body.runId }]);
    const results = new Map([...urls, "undeclared", "cross-workspace"].map((url, i) => [url, body.result.statuses[i]]));
    expect(results.get("https://example.com/")).toBe(200);
    expect([0, 403]).toContain(results.get("https://127.0.0.1/"));
    expect(results.get(urls.find(url => url.includes("httpbin"))!)).toBe(403);
    expect(results.get("undeclared")).toBe(403); expect(results.get("cross-workspace")).toBe(403);
    expect(body.result.wrong).toBe(403);
    expect((await f.post("/sql", { statement: "SELECT 1", params: [] }, f.headers(body.result.token, body.runId))).status).toBe(401);
    expect(await f.pool<{ principal_id: string; parent_run_id: string }[]>`SELECT principal_id,parent_run_id FROM control.runs WHERE id=${body.runId} AND invocation_deployment_id=${id}`)
      .toEqual([{ principal_id: f.ownerId, parent_run_id: f.callerRun }]);
    expect(await f.pool<{ kind: string }[]>`SELECT kind FROM audit.events WHERE run_id=${body.runId} AND kind LIKE 'function.%'`).toEqual([{ kind: "function.complete" }]);
    expect(await f.pool<{ principal_id: string; run_id: string }[]>`SELECT principal_id,run_id FROM audit.events
      WHERE workspace_id=${f.workspaceId} AND kind='function.invoke' AND metadata->>'runId'=${body.runId}`)
      .toEqual([{ principal_id: f.callerId, run_id: f.callerRun }]);
    const revokingId = await f.deploy("revoking", `export default {async fetch(r,props){${f.callbackSource}
      await new Promise(r=>setTimeout(r,1000));
      const after=await fetch(api+'/sql',{method:'POST',headers,body:JSON.stringify({statement:'SELECT 1',params:[]})});
      return Response.json({status:after.status});}}`);
    const revoking = f.post("/functions/revoking/invoke", { input: null });
    await f.observed(revokingId);
    const revoked = await f.app.handle(new Request(`${f.base}/principals/${f.ownerId}/revoke`, { method: "POST", headers: f.userHeaders, body: "{}" }));
    expect(revoked.status).toBe(200);
    const finished = await revoking; expect(finished.status).toBe(200);
    expect((await finished.json()).result).toEqual({ status: 401 });
  } finally { await f.close(); }
}, 45000);

test("server crash leaves expired invocation authority for startup recovery without terminating live or ordinary Runs", async () => {
  const f = await fixture();
  try {
    const id = await f.deploy("orphan", `export default {async fetch(r,props){${f.callbackSource}while(true){}}}`);
    const pending = f.post("/functions/orphan/invoke", { input: null, timeoutMs: 3000 }).catch(() => null);
    const runId = await f.observed(id);
    expect(await reconcileInvocations(f.pool)).toBe(0);
    await f.crash(); await pending;
    expect(await f.pool<{ kind: string }[]>`SELECT kind FROM audit.events WHERE run_id=${runId} AND kind LIKE 'function.%'`).toEqual([]);
    const until = performance.now() + 5000;
    while (true) {
      const [row] = await f.pool<{ expired: boolean }[]>`SELECT expires_at<=clock_timestamp() AS expired FROM control.invocation_tokens WHERE run_id=${runId}`;
      if (row?.expired) break;
      expect(performance.now()).toBeLessThan(until); await Bun.sleep(20);
    }
    // Read the deliberately exported fixture credential through the API, then prove SQL-clock expiry before cleanup.
    const read = await f.app.handle(new Request(`${f.base}/sql`, { method: "POST", headers: f.headers(f.ownerKey, f.ownerRun),
      body: JSON.stringify({ statement: "SELECT value FROM runtime_proof WHERE id=$1", params: [runId] }) }));
    expect(read.status).toBe(200); const token = (await read.json()).rows[0].value;
    const denied = await f.app.handle(new Request(`${f.base}/sql`, { method: "POST", headers: f.headers(token, runId), body: JSON.stringify({ statement: "SELECT 1", params: [] }) }));
    expect(denied.status).toBe(401);
    await f.start();
    const deadline = performance.now() + 15000;
    let terminal;
    do { terminal = await f.pool<{ kind: string; metadata: { durationMs: number } }[]>`SELECT kind,metadata FROM audit.events WHERE run_id=${runId} AND kind LIKE 'function.%'`; if (terminal.length) break; await Bun.sleep(20); } while (performance.now() < deadline);
    expect(terminal).toHaveLength(1); expect(terminal[0]!.kind).toBe("function.fail"); expect(terminal[0]!.metadata.durationMs).toBeGreaterThanOrEqual(3000);
    expect(await f.pool<{ run_id: string }[]>`SELECT run_id FROM control.invocation_tokens WHERE run_id=${runId}`).toEqual([]);
    expect(await f.pool<{ kind: string }[]>`SELECT kind FROM audit.events WHERE run_id=${f.callerRun} AND kind IN ('function.fail','function.complete','function.timeout')`).toEqual([]);
    expect(await reconcileInvocations(f.pool)).toBe(0);
  } finally { await f.close(); }
}, 45000);

test("terminal lock exhaustion is repaired periodically and database delay consumes the dispatch budget", async () => {
  const f = await fixture();
  const release = Promise.withResolvers<void>(); let blocker: Promise<unknown> | undefined;
  try {
    const id = await f.deploy("contention", `export default {async fetch(r,props){${f.callbackSource}await new Promise(r=>setTimeout(r,800));return Response.json(null)}}`);
    const pending = f.post("/functions/contention/invoke", { input: null, timeoutMs: 2000 });
    const runId = await f.observed(id), locked = Promise.withResolvers<void>();
    blocker = withRunContext(f.pool, { workspaceId: f.workspaceId, principalId: f.callerId, runId: f.callerRun }, async () => { locked.resolve(); await release.promise; });
    await locked.promise;
    const response = await pending; expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "invocation_finalize_failed" });
    expect(await f.pool<{ run_id: string }[]>`SELECT run_id FROM control.invocation_tokens WHERE run_id=${runId}`).toEqual([]);
    expect(await f.pool<{ kind: string }[]>`SELECT kind FROM audit.events WHERE run_id=${runId} AND kind LIKE 'function.%'`).toEqual([]);
    release.resolve(); await blocker;
    const until = performance.now() + 15000;
    let events;
    do { events = await f.pool<{ kind: string }[]>`SELECT kind FROM audit.events WHERE run_id=${runId} AND kind LIKE 'function.%'`; if (events.length) break; await Bun.sleep(20); } while (performance.now() < until);
    expect(events).toEqual([{ kind: "function.fail" }]);
    await f.deploy("budget", 'export default {async fetch(){await new Promise(r=>setTimeout(r,1000));return Response.json(null)}}');
    const unlock = Promise.withResolvers<void>(), acquired = Promise.withResolvers<void>();
    const delay = withRunContext(f.pool, { workspaceId: f.workspaceId, principalId: f.callerId, runId: f.callerRun }, async () => { acquired.resolve(); await unlock.promise; });
    await acquired.promise;
    const budgeted = f.post("/functions/budget/invoke", { input: null, timeoutMs: 1500 });
    await Bun.sleep(800); unlock.resolve(); await delay;
    const timed = await budgeted; expect(timed.status).toBe(504); expect(await timed.json()).toEqual({ error: "function_timeout" });
    const successor = await f.post("/functions/budget/invoke", { input: null }); expect(successor.status).toBe(200);
    await f.deploy("long-budget", 'export default {async fetch(){await new Promise(r=>setTimeout(r,11000));return Response.json({ok:true})}}');
    const long = await f.post("/functions/long-budget/invoke", { input: null, timeoutMs: 14000 });
    expect(long.status).toBe(200); expect((await long.json()).result).toEqual({ ok: true });
  } finally { release.resolve(); await blocker; await f.close(); }
}, 45000);
