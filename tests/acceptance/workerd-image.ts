// Artifact protocol gate. Owns one container and never connects to an installed Backplane.
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtemp, mkdir, chmod, copyFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { privateRead } from "../../packages/cli/runtime/credential-file.ts";
import { persistWorkerdEvidence } from "../../infra/bootstrap/workerd-image.ts";
import { readControlSurfaceHash, type RuntimeEvidence } from "../../apps/server/compute/runtime-identity.ts";
import { createComputeLauncher } from "../../apps/server/compute/compute-launcher.ts";
import { compatibilityDate, configHash, sha256, type Manifest } from "../../apps/server/compute/deployment-config.ts";

const root = resolve(import.meta.dir, "../.."), image = Bun.argv[2] ?? "agent-backplane-workerd:1.20260918.1";
const identityOnly = Bun.argv.includes("--identity-only");
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
const binary = expected.get(architecture);
assert(binary);
const runtimeDigest = `workerd-binary-sha256:${binary}`;
const directory = await mkdtemp(join(tmpdir(), "bp-workerd-artifact-")), controlDirectory = join(directory, "control");
let failed = false;
try {
  await mkdir(controlDirectory, { mode: 0o755 });
  await chmod(controlDirectory, 0o755);
  for (const file of ["loader.js", "config.capnp", "start.sh"]) {
    await copyFile(`${root}/apps/server/compute/workerd/${file}`, join(controlDirectory, file));
    await chmod(join(controlDirectory, file), 0o644);
  }
  const evidence = await persistWorkerdEvidence(directory, { reference: image, imageId: identity, binarySha256: binary, architecture, observedAt: new Date().toISOString() });
  const recorded = JSON.parse(await privateRead(evidence) ?? "null");
  assert.equal(recorded.selectedReference, image);
  assert.equal(recorded.hostObservedImageId, identity);
  assert.equal(recorded.binarySha256, binary);
  async function start(hostObservedImageId: string, reference = identity) {
    const container = await docker("create", "--name", name, "--label", `io.backplane.artifact-probe=${owner}`,
      "--pull", "never", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--memory", "512m", "--cpus", "1", "--pids-limit", "128", "--publish", "127.0.0.1::8080", "--env", "BP_COMPUTE_TOKEN",
      "--mount", `type=bind,src=${controlDirectory},dst=/compute,readonly`,
      "--env", `BP_WORKERD_IMAGE=${image}`, "--env", `BP_WORKERD_HOST_IMAGE_ID=${hostObservedImageId}`,
      "--env", `BP_WORKERD_BINARY_SHA256=${binary}`, "--entrypoint", "/bin/sh",
      reference, "/compute/start.sh", "--external-addr=api=127.0.0.1:9");
    await docker("start", container);
    return container;
  }
  let container = await start(identity);
  assert.equal(await docker("inspect", "--format", "{{.Image}}", container), identity);
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
  let address = (await docker("port", container, "8080")).split("\n")[0];
  const launcher = createComputeLauncher({ url: `http://${address}`, token, runtimeDigest });
  assert(launcher);
  let operationEvidence: RuntimeEvidence | undefined;
  async function request(path: string, body: unknown, authorization: string = token, evidence = operationEvidence) {
    assert(evidence, "verify runtime before dispatch");
    const response = await fetch(`http://${address}${path}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json",
        "x-backplane-runtime": evidence.runtimeDigest, "x-backplane-control": evidence.controlHash, "x-backplane-artifact": JSON.stringify(evidence.artifact) }, body: JSON.stringify(body) });
    const bytes = await response.arrayBuffer();
    assert(bytes.byteLength <= 65536, "artifact response too large");
    return { status: response.status, body: new TextDecoder().decode(bytes) };
  }
  assert(digest);
  const value = manifest('export default {async fetch(request, props) { return Response.json({input:await request.json(),workspaceId:props.workspaceId}); }};', runtimeDigest);
  const deadline = performance.now() + 15_000;
  while (true) {
    let response;
    try {
      operationEvidence = await launcher.verify(AbortSignal.timeout(1000)) ?? undefined;
      response = await request("/prepare", value);
    } catch {
      assert.equal(await docker("inspect", "--format", "{{.State.Running}}", container), "true", "runtime exited during startup");
      assert(performance.now() < deadline, "runtime artifact startup deadline exceeded");
      await Bun.sleep(100); continue;
    }
    assert.equal(response.status, 204, "Worker Loader or Check RPC failed"); break;
  }
  assert.equal((await request("/prepare", value, "invalid")).status, 401);
  assert.equal((await request("/prepare", manifest("export default {", runtimeDigest))).status, 422);
  const props = { workspaceId: value.workspaceId, runId: crypto.randomUUID(), token: invocationToken };
  const response = await request("/invoke", { manifest: value, props, input: { fixture: "artifact" } });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { input: { fixture: "artifact" }, workspaceId: value.workspaceId });
  assert(operationEvidence);
  assert.deepEqual(operationEvidence.artifact, { source: "host-declared", reference: image, hostObservedImageId: identity });
  const wrong = createComputeLauncher({ url: `http://${address}`, token, runtimeDigest: `workerd-binary-sha256:${"0".repeat(64)}` });
  assert(wrong);
  assert.equal(await wrong.verify(AbortSignal.timeout(5000)), null);
  assert.deepEqual(await wrong.prepare(value, AbortSignal.timeout(5000), operationEvidence), { ok: false, reason: "compute_unavailable" });
  assert.equal((await request("/prepare", manifest(value.bundle, `workerd-binary-sha256:${"0".repeat(64)}`))).status, 503);
  assert.equal((await request("/invoke", { manifest: manifest(value.bundle, digest), props, input: null })).status, 503, "legacy identity must be refused");
  const refused = await command(["exec", "--env", `BP_WORKERD_BINARY_SHA256=${"0".repeat(64)}`, container, "/bin/sh", "/compute/start.sh"]);
  assert.notEqual(refused.code, 0, "wrong expected binary must refuse startup");
  assert(refused.err.includes("workerd binary identity mismatch"));
  assert.equal((await request("/prepare", value)).status, 204, "refused checks changed healthy runtime identity");
  if (!identityOnly) {
    const https = manifest('export default {async fetch() { const response = await fetch("https://example.com/"); await response.body?.cancel(); return Response.json({status:response.status}); }};', runtimeDigest, ["https://example.com/"]);
    const outbound = await request("/invoke", { manifest: https, props, input: null });
    assert.equal(outbound.status, 200, "declared HTTPS egress failed");
    assert.equal(JSON.parse(outbound.body).status, 200, "HTTPS trust or upstream request failed");
    }
  // Explicit bare deployment resolves a reference again and declares no observed image ID.
  await docker("rm", "--force", container);
  container = await start("", image);
  address = (await docker("port", container, "8080")).split("\n")[0];
  let bare = createComputeLauncher({ url: `http://${address}`, token, runtimeDigest });
  assert(bare);
  async function waitIdentity(controlHash: string) {
    const until = performance.now() + 15000;
    while (performance.now() < until) {
      try {
        const response = await fetch(`http://${address}/identity`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000), redirect: "error" });
        await response.body?.cancel();
        if (response.status === 204 && response.headers.get("x-backplane-control") === controlHash) return;
      } catch { /* Runtime restart is bounded by the deadline. */ }
      await Bun.sleep(100);
    }
    assert.fail("runtime identity startup deadline exceeded");
  }
  const controlHash = await readControlSurfaceHash();
  await waitIdentity(controlHash);
  // The binary/control are unchanged, but the replacement no longer declares an image ID.
  assert.deepEqual(await bare.prepare(value, AbortSignal.timeout(5000), operationEvidence), { ok: false, reason: "compute_unavailable" });
  assert(bare.invoke);
  await assert.rejects(bare.invoke({ manifest: value, props, input: null }, AbortSignal.timeout(5000), operationEvidence), /compute_unavailable/);
  const bareEvidence = await bare.verify(AbortSignal.timeout(5000));
  assert(bareEvidence);
  assert.deepEqual(bareEvidence.artifact, { source: "host-declared", reference: image, hostObservedImageId: null });
  assert.deepEqual(await bare.prepare(value, AbortSignal.timeout(5000), bareEvidence), { ok: true, value: { source: "host-declared", reference: image, hostObservedImageId: null } });

  await appendFile(join(controlDirectory, "loader.js"), "\n// control identity drift fixture\n");
  await docker("restart", container);
  // Docker may allocate a different ephemeral published port on restart.
  address = (await docker("port", container, "8080")).split("\n")[0];
  bare = createComputeLauncher({ url: `http://${address}`, token, runtimeDigest });
  assert(bare);
  await waitIdentity(await readControlSurfaceHash(pathToFileURL(controlDirectory + "/")));
  assert.deepEqual(await bare.prepare(value, AbortSignal.timeout(5000), bareEvidence), { ok: false, reason: "compute_unavailable" });
  assert(bare.invoke);
  await assert.rejects(bare.invoke({ manifest: value, props, input: null }, AbortSignal.timeout(5000), bareEvidence), /compute_unavailable/);
  assert.equal(await bare.verify(AbortSignal.timeout(5000)), null, "changed loader must be refused");
  await copyFile(`${root}/apps/server/compute/workerd/loader.js`, join(controlDirectory, "loader.js"));
  await docker("restart", container);
  address = (await docker("port", container, "8080")).split("\n")[0];
  bare = createComputeLauncher({ url: `http://${address}`, token, runtimeDigest });
  assert(bare);
  await waitIdentity(controlHash);
  assert.deepEqual(await bare.verify(AbortSignal.timeout(5000)), bareEvidence);
  assert((await bare.prepare(value, AbortSignal.timeout(5000), bareEvidence)).ok, "restored control surface must accept the original deployment without redeploy");
  console.log(JSON.stringify({ configuredReference: image, imageId: identity, binarySha256: digest, architecture, runtimeDigest, controlHash, result: identityOnly ? "runtime identity and mismatch refusal passed; attribution requires PG gate" : "artifact identity, restrictions and protocol passed; full runtime qualification remains separate" }));
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
  finally { await rm(directory, { recursive: true, force: true }); }
}
