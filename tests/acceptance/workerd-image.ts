// Artifact protocol gate. Owns one container and never connects to an installed Backplane.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { compatibilityDate, configHash, sha256, type Manifest } from "../../apps/server/compute/deployment-config.ts";

const root = resolve(import.meta.dir, "../.."), image = Bun.argv[2] ?? "agent-backplane-workerd:1.20260918.1";
const token = crypto.randomUUID(), invocationToken = "bp_i_" + sha256(crypto.randomUUID());
const owner = crypto.randomUUID(), name = "bp-workerd-artifact-" + owner;
const expected = new Map([
  ["amd64", "f31da6d248028d698806aa93d1b3aec28bbd4b4b7ddc31e967408ab6406fa5aa"],
  ["arm64", "1ffd1a34403a7f04dc782926fe563efc7d4810ab54d205a00647646dd21a7bba"],
]);
async function command(args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, BP_COMPUTE_TOKEN: token } });
  const timer = setTimeout(() => child.kill(), 120_000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out: out.trim(), err: err.trim() };
  } finally { clearTimeout(timer); }
}
function diagnostic(value: string) {
  return value.replaceAll(token, "[REDACTED]").replaceAll(invocationToken, "[REDACTED]")
    .split("").filter(character => character === "\t" || character === "\n" || (character >= " " && character <= "~")).join("").slice(0, 2048);
}
async function docker(...args: string[]) {
  const result = await command(args);
  assert.equal(result.code, 0, `Docker ${args[0]} failed in the owned artifact fixture: ${diagnostic(result.err)}`);
  return result.out;
}
function manifest(bundle: string, runtimeDigest: string, outboundUrls: string[] = []): Manifest {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const value: Omit<Manifest, "configHash"> = {
    version: 1, workspaceId, functionName: "artifact-probe", id: crypto.randomUUID(), entryPoint: "default",
    compatibilityDate, bundle, bundleSha256: sha256(bundle), outboundUrls,
    keyRef: { workspaceId, principalId: "00000000-0000-4000-8000-000000000002" }, runtimeDigest,
  };
  return { ...value, configHash: configHash(value) };
}
const identity = await docker("image", "inspect", "--format", "{{.Id}}", image);
assert.match(identity, /^sha256:[0-9a-f]{64}$/);
const architecture = await docker("image", "inspect", "--format", "{{.Architecture}}", identity);
assert(expected.has(architecture), "unqualified artifact architecture");
let failed = false;
try {
  const container = await docker("create", "--name", name, "--label", `io.backplane.artifact-probe=${owner}`,
    "--pull", "never", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--publish", "127.0.0.1::8080", "--env", "BP_COMPUTE_TOKEN",
    "--mount", `type=bind,src=${root}/apps/server/compute/workerd,dst=/compute,readonly`,
    identity, "serve", "/compute/config.capnp", "--experimental", "--external-addr=api=127.0.0.1:9");
  await docker("start", container);
  assert.equal(await docker("exec", container, "/usr/bin/workerd", "--version"), "workerd 2026-09-18");
  assert.equal(await docker("exec", container, "id", "-u"), "65534");
  assert.equal(await docker("exec", container, "id", "-g"), "65534");
  const digest = (await docker("exec", container, "sha256sum", "/usr/bin/workerd")).split(" ")[0];
  assert.equal(digest, expected.get(architecture), "running binary differs from pinned upstream artifact");
  assert.equal((await docker("exec", container, "sha256sum", "/usr/share/licenses/workerd/LICENSE")).split(" ")[0],
    "0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594");
  for (const [path, hash] of [
    ["/etc/ssl/certs/ca-certificates.crt", "f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9"],
    ["/usr/share/licenses/ca-certificates/MPL-2.0", "fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85"],
  ] as const) assert.equal((await docker("exec", container, "sha256sum", path)).split(" ")[0], hash);
  assert.equal(await docker("image", "inspect", "--format", '{{index .Config.Labels "io.backplane.workerd.source"}}', identity),
    "https://github.com/cloudflare/workerd/tree/679c09e5eea0af8a04062e1875e99c75af532e3b");
  const address = (await docker("port", container, "8080")).split("\n")[0];
  async function request(path: string, body: unknown, authorization: string = token) {
    const response = await fetch(`http://${address}${path}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const bytes = await response.arrayBuffer();
    assert(bytes.byteLength <= 65536, "artifact response too large");
    return { status: response.status, body: new TextDecoder().decode(bytes) };
  }
  assert(digest);
  const value = manifest('export default {async fetch(request, props) { return Response.json({input:await request.json(),workspaceId:props.workspaceId}); }};', digest);
  const deadline = performance.now() + 15_000;
  while (true) {
    let response;
    try { response = await request("/prepare", value); } catch {
      assert.equal(await docker("inspect", "--format", "{{.State.Running}}", container), "true", "runtime exited during startup");
      assert(performance.now() < deadline, "runtime artifact startup deadline exceeded");
      await Bun.sleep(100); continue;
    }
    assert.equal(response.status, 204, "Worker Loader or Check RPC failed"); break;
  }
  assert.equal((await request("/prepare", value, "invalid")).status, 401);
  assert.equal((await request("/prepare", manifest("export default {", digest))).status, 422);
  const props = { workspaceId: value.workspaceId, runId: crypto.randomUUID(), token: invocationToken };
  const response = await request("/invoke", { manifest: value, props, input: { fixture: "artifact" } });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { input: { fixture: "artifact" }, workspaceId: value.workspaceId });
  const https = manifest('export default {async fetch() { const response = await fetch("https://example.com/"); await response.body?.cancel(); return Response.json({status:response.status}); }};', digest, ["https://example.com/"]);
  const outbound = await request("/invoke", { manifest: https, props, input: null });
  assert.equal(outbound.status, 200, "declared HTTPS egress failed");
  assert.equal(JSON.parse(outbound.body).status, 200, "HTTPS trust or upstream request failed");
  console.log(JSON.stringify({ imageId: identity, binarySha256: digest, result: "artifact identity, restrictions and protocol passed; full runtime qualification remains separate" }));
} catch (error) {
  failed = true;
  const logs = await command(["logs", "--tail", "40", name]).catch(() => null);
  if (logs) console.error(diagnostic(logs.out + "\n" + logs.err));
  throw error;
} finally {
  try {
    const observed = await command(["inspect", "--format", '{{.Id}} {{index .Config.Labels "io.backplane.artifact-probe"}}', name]);
    if (observed.code === 0) {
      const [id, label] = observed.out.split(" ");
      assert(id && label === owner, "artifact cleanup ownership mismatch; container retained");
      assert.equal((await command(["rm", "--force", id])).code, 0, "artifact fixture cleanup failed");
    } else assert(failed, "artifact cleanup could not verify ownership");
  } catch (error) {
    if (failed) console.error("artifact fixture cleanup failed; original probe error retained");
    else assert.fail(error instanceof Error ? error.message : "artifact fixture cleanup failed");
  }
}
