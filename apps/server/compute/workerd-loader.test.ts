// Pure control-boundary tests; Worker Loader and workerd execution require the real artifact gate.
import { expect, test } from "bun:test";
import { createComputeLauncher } from "./compute-launcher.ts";
import { readControlSurfaceHash } from "./runtime-identity.ts";
import { compatibilityDate, configHash, sha256 } from "./deployment-config.ts";
const source = await Bun.file(new URL("./workerd/loader.js", import.meta.url)).text();
const evaluate = new Function("WorkerEntrypoint", source
  .replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
  .replace("export default {", "const handler = {")
  .replace("export class Egress", "class Egress") + "\nreturn handler;");
const loader: { fetch(request: Request, env: Record<string, unknown>, ctx: unknown): Promise<Response> } = evaluate(class {});
const runtimeDigest = "workerd-binary-sha256:" + "a".repeat(64);
const env = { TOKEN: "control-secret", RUNTIME_ID: runtimeDigest, CONTROL_SHA256: "b".repeat(64), IMAGE_REFERENCE: "fixture:local", HOST_IMAGE_ID: "" };
function request(path: string, body?: unknown, token = env.TOKEN) {
  return new Request(`http://runtime${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "x-backplane-runtime": runtimeDigest, "x-backplane-control": env.CONTROL_SHA256,
      "x-backplane-artifact": JSON.stringify({ source: "host-declared", reference: env.IMAGE_REFERENCE, hostObservedImageId: null }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
test("control identity is authenticated and reports only a measured namespaced identity", async () => {
  expect((await loader.fetch(request("/identity", undefined, "wrong"), env, {})).status).toBe(401);
  expect((await loader.fetch(request("/identity"), { TOKEN: env.TOKEN }, {})).status).toBe(503);
  expect((await loader.fetch(request("/identity"), { ...env, RUNTIME_ID: "a".repeat(64) }, {})).status).toBe(503);
  const response = await loader.fetch(request("/identity"), env, {});
  expect(response.status).toBe(204);
  expect(response.headers.get("x-backplane-runtime")).toBe(runtimeDigest);
  expect(response.headers.get("x-backplane-control")).toBe(env.CONTROL_SHA256);
  expect(JSON.parse(response.headers.get("x-backplane-artifact") ?? "null")).toEqual({ source: "host-declared", reference: "fixture:local", hostObservedImageId: null });
});
test("wrong and legacy manifest identities are refused before touching a child loader", async () => {
  for (const digest of ["a".repeat(64), "workerd-binary-sha256:" + "b".repeat(64)]) {
    expect((await loader.fetch(request("/prepare", { runtimeDigest: digest }), env, {})).status).toBe(503);
    expect((await loader.fetch(request("/invoke", { manifest: { runtimeDigest: digest } }), env, {})).status).toBe(503);
  }
  expect((await loader.fetch(request("/identity"), env, {})).headers.get("x-backplane-runtime")).toBe(runtimeDigest);
});


test("missing or oversized operation evidence is refused before parsing the body", async () => {
  for (const name of ["x-backplane-runtime", "x-backplane-control", "x-backplane-artifact"]) {
    for (const path of ["/prepare", "/invoke"]) {
      const missing = request(path, { invalid: "bundle" });
      missing.headers.delete(name);
      expect((await loader.fetch(missing, env, {})).status).toBe(503);
      const oversized = request(path, { invalid: "bundle" });
      oversized.headers.set(name, "a".repeat(1025));
      expect((await loader.fetch(oversized, env, {})).status).toBe(503);
    }
  }
});

test("one verification binds prepare and invoke to the loader's control and artifact observation", async () => {
  let children = 0;
  const current = { ...env, CONTROL_SHA256: await readControlSurfaceHash(), LOADER: { get() {
    children++;
    return { getEntrypoint() { return { check: async () => true, fetch: async () => Response.json({ ok: true }, { status: 503 }) }; } };
  } } };
  const paths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    paths.push(new URL(request.url).pathname);
    return loader.fetch(request, current, { exports: { Egress: () => ({}) } });
  } });
  try {
    const launcher = createComputeLauncher({ url: server.url.href, token: env.TOKEN, runtimeDigest });
    if (!launcher?.invoke) throw Error("launcher missing");
    const bundle = "export default { fetch() {} }";
    const input = { version: 1, workspaceId: "w", functionName: "f", id: "id", bundle, bundleSha256: sha256(bundle),
      entryPoint: "default", compatibilityDate, outboundUrls: [], keyRef: { workspaceId: "w", principalId: "p" }, runtimeDigest } as const;
    const manifest = { ...input, outboundUrls: [], configHash: configHash({ ...input, outboundUrls: [] }) };
    const invocation = { manifest, props: { token: "bp_i_" + "a".repeat(64), runId: crypto.randomUUID(), workspaceId: "w" }, input: null };
    const signal = AbortSignal.timeout(5000), evidence = await launcher.verify(signal);
    if (!evidence) throw Error("verification failed");
    expect(await launcher.prepare(manifest, signal, evidence)).toEqual({ ok: true, value: evidence.artifact });
    const response = await launcher.invoke(invocation, signal, evidence);
    expect(response.status).toBe(503); // An ordinary function response remains an invocation result.
    expect(await response.json()).toEqual({ ok: true });
    expect(children).toBe(2);
    for (const change of [{ CONTROL_SHA256: "c".repeat(64) }, { IMAGE_REFERENCE: "fixture:replacement" }, { HOST_IMAGE_ID: "sha256:" + "d".repeat(64) }]) {
      Object.assign(current, env, { CONTROL_SHA256: evidence.controlHash }, change);
      expect(await launcher.prepare(manifest, signal, evidence)).toEqual({ ok: false, reason: "compute_unavailable" });
      await expect(launcher.invoke(invocation, signal, evidence)).rejects.toThrow("compute_unavailable");
      expect(children).toBe(2);
    }
    expect(paths).toEqual(["/identity", "/prepare", "/invoke", "/prepare", "/invoke", "/prepare", "/invoke", "/prepare", "/invoke"]);
    const refreshed = await launcher.verify(signal);
    if (!refreshed) throw Error("changed valid artifact must be verifiable");
    expect(await launcher.prepare(manifest, signal, refreshed)).toEqual({ ok: true, value: refreshed.artifact });
    expect(children).toBe(3);
  } finally { await server.stop(true); }
});
