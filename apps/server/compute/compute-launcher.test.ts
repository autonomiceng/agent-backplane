import { expect, test } from "bun:test";
import { readControlSurfaceHash, type ArtifactEvidence } from "./runtime-identity.ts";
import { createComputeLauncher } from "./compute-launcher.ts";
import { compatibilityDate, checkSource, configHash, sha256, type Manifest } from "./deployment-config.ts";

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
  expect(await launcher.prepare(manifest, new AbortController().signal)).toEqual({ ok: false, reason: "compute_unavailable" });
  await expect(launcher.invoke(invocation, new AbortController().signal)).rejects.toThrow("compute_unavailable");
  const controller = new AbortController();
  controller.abort(new Error("caller_cancelled"));
  await expect(launcher.invoke(invocation, controller.signal)).rejects.toThrow("caller_cancelled");
  await expect(launcher.prepare(manifest, controller.signal)).rejects.toThrow("caller_cancelled");
});

test("loader validation source and compatibility date drift from hashed server manifests", async () => {
  const loader = await Bun.file(new URL("./workerd/loader.js", import.meta.url)).text();
  expect(loader.match(/const checkSource = `([\s\S]*?)`;/)?.[1]).toBe(checkSource);
  expect(loader.match(/m\.compatibilityDate !== "([^"]+)"/)?.[1]).toBe(compatibilityDate);
});

test("verified runtime must match before preparation and invocation; replacement is rechecked", async () => {
  const runtimeDigest = "workerd-binary-sha256:" + "a".repeat(64);
  let observed = runtimeDigest;
  const control = await readControlSurfaceHash();
  let observedControl = control;
  const artifact: ArtifactEvidence = { source: "host-declared", reference: "fixture:local", hostObservedImageId: null };
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
    expect(await launcher.verify(signal)).toEqual(artifact);
    expect(await launcher.prepare(manifest, signal)).toEqual({ ok: true, value: artifact });
    expect(paths).toEqual(["/identity", "/identity", "/prepare"]);
    paths.length = 0;
    observed = "workerd-binary-sha256:" + "b".repeat(64);
    expect(await launcher.verify(signal)).toBeNull();
    expect(await launcher.prepare(manifest, signal)).toEqual({ ok: false, reason: "compute_unavailable" });
    await expect(launcher.invoke({ manifest, props: { token: "test", runId: "r", workspaceId: "w" }, input: null }, signal)).rejects.toThrow("compute_unavailable");
    expect(paths).toEqual(["/identity", "/identity", "/identity"]);
    paths.length = 0;
    observed = runtimeDigest;
    expect(await launcher.prepare({ ...manifest, runtimeDigest: "a".repeat(64) }, signal)).toEqual({ ok: false, reason: "compute_unavailable" });
    const legacy = createComputeLauncher({ url: server.url.href, token: "private-runtime", runtimeDigest: "a".repeat(64) });
    expect(await legacy?.verify(signal)).toBeNull();
    expect(paths).toEqual([]);
    observedControl = "0".repeat(64);
    expect(await launcher.verify(signal)).toBeNull();
    expect(await launcher.prepare(manifest, signal)).toEqual({ ok: false, reason: "compute_unavailable" });
    expect(paths).toEqual(["/identity", "/identity"]);
    observedControl = control;
    expect(await launcher.verify(signal)).toEqual(artifact);
  } finally { await server.stop(true); }
});
