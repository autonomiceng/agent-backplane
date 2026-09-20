// Pure control-boundary tests; Worker Loader and workerd execution require the real artifact gate.
import { expect, test } from "bun:test";
const source = await Bun.file(new URL("./loader.js", import.meta.url)).text();
const evaluate = new Function("WorkerEntrypoint", source
  .replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
  .replace("export default {", "const handler = {")
  .replace("export class Egress", "class Egress") + "\nreturn handler;");
const loader: { fetch(request: Request, env: Record<string, string>, ctx: unknown): Promise<Response> } = evaluate(class {});
const runtimeDigest = "workerd-binary-sha256:" + "a".repeat(64);
const env = { TOKEN: "control-secret", RUNTIME_ID: runtimeDigest, CONTROL_SHA256: "b".repeat(64), IMAGE_REFERENCE: "fixture:local", HOST_IMAGE_ID: "" };
function request(path: string, body?: unknown, token = env.TOKEN) {
  return new Request(`http://runtime${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
