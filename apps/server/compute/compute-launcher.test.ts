import { expect, test } from "bun:test";
import { createComputeLauncher } from "./compute-launcher.ts";
import { compatibilityDate, checkSource, configHash, sha256, type Manifest } from "./deployment-config.ts";

test("unreachable runtime is categorized as compute_unavailable and cancellation keeps its cause", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204 }) });
  const url = server.url.href;
  await server.stop(true);
  const launcher = createComputeLauncher({ url, token: "private-runtime", runtimeDigest: "a".repeat(64) });
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
