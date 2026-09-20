// Six F-GATE cases against actual host Bun + checksum-verified workerd. EPERM fails the gate.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createComputeLauncher } from "../../apps/server/compute/compute-launcher.ts";
import { configHash, sha256, compatibilityDate, type Manifest } from "../../apps/server/compute/deployment-config.ts";
import { readControlSurfaceHash } from "../../apps/server/compute/runtime-identity.ts";

const token = crypto.randomUUID();
let child: Bun.Subprocess<"ignore", "pipe", "inherit">;
let url: string, runtimeDigest: string;
let headers: Record<string, string>;
const workspaceId = crypto.randomUUID();
function manifest(bundle: string): Manifest {
  const value = { version: 1 as const, id: crypto.randomUUID(), workspaceId, functionName: "probe", bundle, bundleSha256: sha256(bundle),
    entryPoint: "default" as const, compatibilityDate, outboundUrls: [], keyRef: { workspaceId, principalId: crypto.randomUUID() }, runtimeDigest };
  return { ...value, configHash: configHash(value) };
}
const props = { workspaceId, runId: crypto.randomUUID(), token: "bp_i_" + "a".repeat(64) };
const healthy = 'export default {fetch(){return Response.json({ok:true})}}';
function request(bundle: string, budget = 2000, signal = AbortSignal.timeout(6000), path = "/invoke") {
  const m = manifest(bundle);
  return fetch(new URL(path, url), { method: "POST", headers: { ...headers, "x-backplane-budget-ms": String(budget) },
    body: JSON.stringify(path === "/prepare" ? m : { manifest: m, props, input: null }), signal, redirect: "manual" });
}
async function children() {
  const value = await readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8");
  return value.trim().split(/\s+/).filter(Boolean).map(Number);
}
async function running() {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) { const pids = await children(); if (pids.length) return pids; await Bun.sleep(10); }
  throw Error("actual child did not start");
}
async function drained() {
  const deadline = performance.now() + 3000;
  while ((await children()).length && performance.now() < deadline) await Bun.sleep(10);
  expect(await children()).toEqual([]);
}
async function healthyAgain() {
  await drained();
  const response = await request(healthy);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
  expect(await children()).toEqual([]);
}
beforeAll(async () => {
  child = Bun.spawn([process.execPath, "tests/acceptance/workerd-prototype.ts"], {
    env: { ...Bun.env, BP_COMPUTE_TOKEN: token, BP_COMPUTE_TIMEOUT_MS: "15000" }, stdin: "ignore", stdout: "pipe", stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const { value, done } = await reader.read();
    if (done) throw Error(`prototype failed before listening (exit ${await child.exited})`);
    ({ url, runtimeDigest } = JSON.parse(new TextDecoder().decode(value)));
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const launcher = createComputeLauncher({ url, token, runtimeDigest });
  const evidence = await launcher?.verify(AbortSignal.timeout(2000));
  expect(evidence).toBeTruthy();
  headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-backplane-runtime": runtimeDigest,
    "x-backplane-control": await readControlSurfaceHash(), "x-backplane-artifact": JSON.stringify(evidence?.artifact) };
});
afterAll(async () => { if (child) { child.kill("SIGTERM"); await child.exited; } });

test("initializer and handler loops terminate their captured children and permit a healthy successor", async () => {
  for (const [bundle, path] of [["while(true){}; export default {}", "/prepare"], ['export default {fetch(){while(true){}}}', "/invoke"]]) {
    const response = request(bundle!, 500, undefined, path);
    const pids = await running();
    expect((await response).headers.get("x-backplane-error")).toBe("function_timeout");
    for (const pid of pids) expect(existsSync(`/proc/${pid}`)).toBe(false);
    await healthyAgain();
  }
  const long = await request('export default {async fetch(){await new Promise(r=>setTimeout(r,11000));return Response.json({ok:true})}}', 14000, AbortSignal.timeout(16000));
  expect(long.status).toBe(200); expect(await long.json()).toEqual({ ok: true });
  expect(await children()).toEqual([]);
}, 25000);

test("wire disconnect bounds child lifetime and response completion kills waitUntil work", async () => {
  const controller = new AbortController();
  const response = request('export default {fetch(){while(true){}}}', 1500, controller.signal);
  const rejection = response.catch(() => null);
  const pids = await running();
  const abortedAt = performance.now(); controller.abort(); await rejection;
  await drained();
  console.log(JSON.stringify({ disconnectReapedMs: Math.ceil(performance.now() - abortedAt), requestSignalObservedPromptly: performance.now() - abortedAt < 500, hardDeadlineMs: 1500 }));
  for (const pid of pids) expect(existsSync(`/proc/${pid}`)).toBe(false);
  const background = await request('export default {fetch(r,p,ctx){ctx.waitUntil(new Promise(resolve=>setTimeout(()=>{while(true){}},100)));return Response.json({ok:true})}}');
  expect(await background.json()).toEqual({ ok: true }); expect(await children()).toEqual([]);
  await healthyAgain();
}, 10000);

test("body and response caps reap children while redirects cannot forge control markers", async () => {
  const oversized = await fetch(new URL("/invoke", url), { method: "POST", headers, body: "x".repeat(26 * 1048576), signal: AbortSignal.timeout(5000) });
  expect(oversized.headers.get("x-backplane-error")).toBe("function_failed");
  expect(await children()).toEqual([]);
  const response = await request('export default {fetch(){return new Response("x".repeat(1048577))}}');
  expect(response.headers.get("x-backplane-error")).toBe("function_failed");
  expect(await children()).toEqual([]);
  const redirect = await request('export default {fetch(){return Response.json({ordinary:true},{status:302,headers:{location:"http://127.0.0.1:9/","x-backplane-error":"function_timeout"}})}}');
  expect(redirect.status).toBe(302); expect(redirect.headers.get("x-backplane-error")).toBeNull();
  expect(await redirect.json()).toEqual({ ordinary: true }); await healthyAgain();
}, 10000);

test("a full operation slot refuses extra spawn while singleflight identity stays healthy within two seconds", async () => {
  const pending = request('export default {fetch(){while(true){}}}', 4000);
  const pids = await running();
  console.log(JSON.stringify({ childOomScore: await readFile(`/proc/${pids[0]}/oom_score_adj`, "utf8") }));
  const busy = await request(healthy);
  expect(busy.headers.get("x-backplane-error")).toBe("compute_unavailable");
  expect(await children()).toEqual(pids);
  const started = performance.now();
  const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(new URL("/identity", url), { headers, signal: AbortSignal.timeout(2000) })));
  for (const response of responses) expect(response.status).toBe(204);
  expect(performance.now() - started).toBeLessThan(2000);
  expect(await children()).toEqual(pids);
  expect((await pending).status).toBe(504); await healthyAgain();
}, 10000);

test("a mismatched admission observation is refused and reaped before a healthy successor", async () => {
  const bad = await fetch(new URL("/identity", url), { headers: { authorization: "Bearer wrong" } });
  expect(bad.status).toBe(401); expect(await children()).toEqual([]);
  const response = await fetch(new URL("/invoke", url), { method: "POST", headers: { ...headers, "x-backplane-control": "0".repeat(64) },
    body: JSON.stringify({ manifest: manifest("while(true){};export default {}"), props, input: null }), signal: AbortSignal.timeout(2000) });
  expect(response.status).toBe(503); expect(response.headers.get("x-backplane-error")).toBe("compute_unavailable");
  expect(await children()).toEqual([]); await healthyAgain();
});

test("completion reaps actual children and a stuck exit observation fatally terminates its parent", async () => {
  await healthyAgain();
  const module = new URL("../../apps/server/compute/workerd/child-process.ts", import.meta.url).href;
  const fixture = Bun.spawn([process.execPath, "-e", `import {killAndReap} from ${JSON.stringify(module)};
    const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore'});
    console.log(child.pid);
    await killAndReap({kill:()=>child.kill('SIGKILL'),exited:new Promise(()=>{})},()=>process.exit(23));`], { stdout: "pipe", stderr: "inherit" });
  const timer = setTimeout(() => fixture.kill("SIGKILL"), 4000);
  try {
    const pid = Number(await new Response(fixture.stdout).text());
    expect(await fixture.exited).toBe(23); expect(existsSync(`/proc/${pid}`)).toBe(false);
  } finally { clearTimeout(timer); }
}, 6000);
