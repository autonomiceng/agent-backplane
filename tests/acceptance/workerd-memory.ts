// Case 10's authority evidence. Run only against root's owned 512 MiB runtime container.
import { expect, test } from "bun:test";
import { workerdPgFixture } from "./workerd-pg-fixture.ts";

test("container memory failure closes the invocation Run and credential before a healthy successor", async () => {
  if (Bun.env.BP_TEST_MEMORY_CONTAINER !== "512m") throw Error("explicit owned 512m runtime container required; never run memory bombs on host prototype");
  const f = await workerdPgFixture();
  try {
    const id = await f.deploy("memory", `export default {async fetch(r,props){${f.callbackSource}
      const retained=[];while(true){const bytes=new Uint8Array(16*1024*1024);bytes.fill(1);retained.push(bytes)}}}`);
    const response = await f.post("/functions/memory/invoke", { input: null });
    expect([502, 503]).toContain(response.status);
    expect(["function_failed", "compute_unavailable"]).toContain((await response.json()).error);
    const runId = await f.observed(id);
    expect(await f.pool<{ kind: string }[]>`SELECT kind FROM audit.events WHERE run_id=${runId} AND kind LIKE 'function.%'`).toEqual([{ kind: "function.fail" }]);
    expect(await f.pool<{ run_id: string }[]>`SELECT run_id FROM control.invocation_tokens WHERE run_id=${runId}`).toEqual([]);
    const read = await f.app.handle(new Request(`${f.base}/sql`, { method: "POST", headers: f.headers(f.ownerKey, f.ownerRun),
      body: JSON.stringify({ statement: "SELECT value FROM runtime_proof WHERE id=$1", params: [runId] }) }));
    expect(read.status).toBe(200); const token = (await read.json()).rows[0].value;
    expect((await f.post("/sql", { statement: "SELECT 1", params: [] }, f.headers(token, runId))).status).toBe(401);
    // The companion artifact fixture asserts cgroup recovery, owned child exit and absence of zombies.
    const until = performance.now() + 15000;
    while (true) {
      const probe = await fetch(new URL("identity", Bun.env.BP_COMPUTE_URL!.replace(/\/?$/, "/")), {
        headers: { authorization: `Bearer ${Bun.env.BP_COMPUTE_TOKEN}` }, signal: AbortSignal.timeout(2000), redirect: "error",
      }).catch(() => null);
      if (probe?.status === 204) break;
      expect(performance.now()).toBeLessThan(until); await Bun.sleep(100);
    }
    await f.deploy("recovered", 'export default {fetch(){return Response.json({ok:true})}}');
    const successor = await f.post("/functions/recovered/invoke", { input: null });
    expect(successor.status).toBe(200); expect((await successor.json()).result).toEqual({ ok: true });
  } finally { await f.close(); }
}, 45000);
