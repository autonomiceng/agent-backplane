import { expect, spyOn, test } from "bun:test";
import { readControlSurfaceHash, type ArtifactEvidence, type RuntimeEvidence } from "./runtime-identity.ts";
import { createComputeLauncher } from "./compute-launcher.ts";
import { compatibilityDate, checkSource, configHash, sha256, type Manifest } from "./deployment-config.ts";

const artifact: ArtifactEvidence = { source: "host-declared", reference: "fixture:local", hostObservedImageId: null };
const evidence: RuntimeEvidence = { runtimeDigest: "workerd-binary-sha256:" + "a".repeat(64), controlHash: await readControlSurfaceHash(), artifact };

test("unreachable runtime is categorized as compute_unavailable and cancellation keeps its cause", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
  const url = server.url.href;
  await server.stop(true);
  const launcher = createComputeLauncher({ url, token: "private-runtime", runtimeDigest: "workerd-binary-sha256:" + "a".repeat(64) });
  if (!launcher?.invoke) throw new Error("launcher missing");
  const input: Omit<Manifest, "configHash"> = { version: 1, workspaceId: crypto.randomUUID(), functionName: "example",
    id: crypto.randomUUID(), bundle: "export default {}", bundleSha256: sha256("export default {}"), entryPoint: "default",
    compatibilityDate, outboundUrls: [], keyRef: { workspaceId: "workspace", principalId: "principal" }, runtimeDigest: launcher.runtimeDigest };
  const manifest = { ...input, configHash: configHash(input) };
  const invocation = { manifest, props: { token: "temporary", workspaceId: input.workspaceId, runId: crypto.randomUUID() }, input: {} };
  expect(await launcher.prepare(manifest, new AbortController().signal, evidence)).toEqual({ ok: false, reason: "compute_unavailable" });
  await expect(launcher.invoke(invocation, new AbortController().signal, evidence)).rejects.toThrow("compute_unavailable");
  const controller = new AbortController();
  controller.abort(new Error("caller_cancelled"));
  await expect(launcher.invoke(invocation, controller.signal, evidence)).rejects.toThrow("caller_cancelled");
  await expect(launcher.prepare(manifest, controller.signal, evidence)).rejects.toThrow("caller_cancelled");
});

test("loader validation source and compatibility date drift from hashed server manifests", async () => {
  const loader = await Bun.file(new URL("./workerd/loader.js", import.meta.url)).text();
  expect(loader.match(/const checkSource = `([\s\S]*?)`;/)?.[1]).toBe(checkSource);
  expect(loader.match(/m\.compatibilityDate !== "([^"]+)"/)?.[1]).toBe(compatibilityDate);
});

test("identity verification detects runtime replacement and control drift; dispatch retains manifest guards", async () => {
  const runtimeDigest = "workerd-binary-sha256:" + "a".repeat(64);
  let observed = runtimeDigest;
  const control = await readControlSurfaceHash();
  let observedControl = control;
  const paths: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    expect(request.headers.get("authorization")).toBe("Bearer private-runtime");
    return new Response(null, { status: 204, headers: path === "/identity" ? { "x-backplane-runtime": observed, "x-backplane-control": observedControl, "x-backplane-artifact": JSON.stringify(artifact) } : {} });
  } });
  try {
    const launcher = createComputeLauncher({ url: server.url.href, token: "private-runtime", runtimeDigest });
    if (!launcher?.invoke) throw Error("launcher missing");
    const m: Omit<Manifest, "configHash"> = { version: 1, workspaceId: "w", functionName: "f", id: "id",
      bundle: "export default {}", bundleSha256: sha256("export default {}"), entryPoint: "default", compatibilityDate,
      outboundUrls: [], keyRef: { workspaceId: "w", principalId: "p" }, runtimeDigest };
    const manifest = { ...m, configHash: configHash(m) }, signal = new AbortController().signal;
    expect(await launcher.verify(signal)).toEqual(evidence);
    expect(await launcher.prepare(manifest, signal, evidence)).toEqual({ ok: true, value: artifact });
    await launcher.invoke({ manifest, props: { token: "test", runId: "r", workspaceId: "w" }, input: null }, signal, evidence);
    expect(paths).toEqual(["/identity", "/prepare", "/invoke"]);
    paths.length = 0;
    observed = "workerd-binary-sha256:" + "b".repeat(64);
    expect(await launcher.verify(signal)).toBeNull();
    await expect(launcher.invoke({ manifest: { ...manifest, runtimeDigest: "a".repeat(64) }, props: { token: "test", runId: "r", workspaceId: "w" }, input: null }, signal, evidence)).rejects.toThrow("compute_unavailable");
    expect(paths).toEqual(["/identity"]);
    paths.length = 0;
    observed = runtimeDigest;
    expect(await launcher.prepare({ ...manifest, runtimeDigest: "a".repeat(64) }, signal, evidence)).toEqual({ ok: false, reason: "compute_unavailable" });
    const legacy = createComputeLauncher({ url: server.url.href, token: "private-runtime", runtimeDigest: "a".repeat(64) });
    expect(await legacy?.verify(signal)).toBeNull();
    expect(paths).toEqual([]);
    observedControl = "0".repeat(64);
    expect(await launcher.verify(signal)).toBeNull();
    expect(paths).toEqual(["/identity"]);
    observedControl = control;
    expect(await launcher.verify(signal)).toEqual(evidence);
  } finally { await server.stop(true); }
});


test("unsafe compute authorities never receive the control token or an operation", async () => {
  const transport = spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not send credentials"));
  try {
    const m: Omit<Manifest, "configHash"> = { version: 1, workspaceId: "w", functionName: "f", id: "id",
      bundle: "export default {}", bundleSha256: sha256("export default {}"), entryPoint: "default", compatibilityDate,
      outboundUrls: [], keyRef: { workspaceId: "w", principalId: "p" }, runtimeDigest: evidence.runtimeDigest };
    const manifest = { ...m, configHash: configHash(m) }, signal = new AbortController().signal;
    for (const url of ["http://remote.example:8080", "http://10.0.0.1:8080", "http://[::]:8080", "http://0.0.0.0:8080",
      "http://workerd:8081", "http://workerd.example:8080", "http://localhost.example:8080", "http://[::ffff:192.0.2.1]:8080",
      "https://user:secret@runtime.example", "http://workerd:8080@remote.example", "ftp://localhost/", "not a URL",
      "https://runtime.example/base?route=other", "https://runtime.example/base#fragment", "https://runtime.example/base?", "https://runtime.example/base#"]) {
      const launcher = createComputeLauncher({ url, token: "must-stay-local", runtimeDigest: evidence.runtimeDigest });
      if (!launcher?.invoke) throw Error("launcher missing");
      expect(await launcher.verify(signal)).toBeNull();
      expect(await launcher.prepare(manifest, signal, evidence)).toEqual({ ok: false, reason: "compute_unavailable" });
      await expect(launcher.invoke({ manifest, props: { token: "temporary", runId: "r", workspaceId: "w" }, input: null }, signal, evidence)).rejects.toThrow("compute_unavailable");
    }
    expect(transport).not.toHaveBeenCalled();
  } finally { transport.mockRestore(); }
});

test("private HTTP, loopback and HTTPS preserve the configured authority and path prefix", async () => {
  const transport = spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204, headers: {
    "x-backplane-runtime": evidence.runtimeDigest, "x-backplane-control": evidence.controlHash, "x-backplane-artifact": JSON.stringify(artifact),
  } }));
  try {
    for (const url of ["http://workerd:8080", "http://127.0.0.1:49152/base/", "http://127.0.0.2:8080", "http://localhost:8080", "http://[::1]:8080/base",
      "https://remote.example/prefix/", "https://remote.example//other.example/prefix"]) {
      const launcher = createComputeLauncher({ url, token: "control-token", runtimeDigest: evidence.runtimeDigest });
      expect(await launcher?.verify(new AbortController().signal)).toEqual(evidence);
      const expected = new URL(url);
      expected.pathname = expected.pathname.replace(/\/$/, "") + "/identity";
      const call = transport.mock.calls.at(-1);
      expect(String(call?.[0])).toBe(expected.href);
      expect(new Headers(call?.[1]?.headers).get("authorization")).toBe("Bearer control-token");
      expect(call?.[1]?.redirect).toBe("error");
    }
  } finally { transport.mockRestore(); }
});
