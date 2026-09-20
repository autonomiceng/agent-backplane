// main.ts supplies configuration; compute adapters supply immutable manifests and abort signals.
import { computeFailure, computeSuccess, type ComputeResult } from "./compute-error.ts";
import { readArtifactEvidence, readControlSurfaceHash, type ArtifactEvidence } from "./runtime-identity.ts";
import type { Manifest } from "./deployment-config.ts";
export type Invocation = { manifest: Manifest; props: { token: string; runId: string; workspaceId: string }; input: unknown };
export type ComputeLauncher = { runtimeDigest: string; timeoutMs?: number; verify(signal: AbortSignal): Promise<ArtifactEvidence | null>; invoke?(invocation: Invocation, signal: AbortSignal): Promise<Response>; prepare(manifest: Manifest, signal: AbortSignal): Promise<ComputeResult<ArtifactEvidence>> };
export function createComputeLauncher(config: { url: string | undefined; token: string | undefined; runtimeDigest: string | undefined; timeoutMs?: string | undefined }): ComputeLauncher | undefined {
  if (!config.url) return undefined;
  const { token, runtimeDigest = "" } = config;
  const timeoutMs = config.timeoutMs === undefined ? 10000 : Number(config.timeoutMs);
  let endpoint: URL | undefined;
  try {
    const url = new URL(config.url);
    if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647 && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && token && /^workerd-binary-sha256:[0-9a-f]{64}$/.test(runtimeDigest)) {
      endpoint = new URL(`${url.pathname.replace(/\/$/, "")}/prepare`, url);
    }
  } catch { /* Invalid configuration disables compute operations without blocking core. */ }
  const verify = async (signal: AbortSignal) => {
    if (!endpoint) return null;
    try {
      const response = await fetch(new URL(endpoint.href.replace(/\/prepare$/, "/identity")), {
        headers: { authorization: `Bearer ${token}` }, signal, redirect: "error" });
      await response.body?.cancel();
      if (response.status !== 204 || response.headers.get("x-backplane-runtime") !== runtimeDigest
        || response.headers.get("x-backplane-control") !== await readControlSurfaceHash()) return null;
      return readArtifactEvidence(response.headers.get("x-backplane-artifact"));
    } catch (error) {
      if (signal.aborted) throw error;
      return null;
    }
  };
  return { runtimeDigest, verify, timeoutMs: endpoint ? timeoutMs : 10000, async invoke(invocation, signal) {
    if (!endpoint || invocation.manifest.runtimeDigest !== runtimeDigest || !await verify(signal)) throw new Error("compute_unavailable");
    try {
      return await fetch(new URL(endpoint.href.replace(/\/prepare$/, "/invoke")), { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(invocation), signal, redirect: "manual" });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error("compute_unavailable");
    }
  }, async prepare(manifest, signal) {
    if (!endpoint || manifest.runtimeDigest !== runtimeDigest) return computeFailure("compute_unavailable");
    const artifact = await verify(signal);
    if (!artifact) return computeFailure("compute_unavailable");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(manifest), signal, redirect: "error" });
      await response.body?.cancel();
      if (response.status === 422) return computeFailure("bundle_invalid");
      return response.status === 204 ? computeSuccess(artifact) : computeFailure("compute_unavailable");
    } catch (error) {
      if (signal.aborted) throw error;
      return computeFailure("compute_unavailable");
    }
  } };
}
export async function prepareDeployment(launcher: ComputeLauncher, manifest: Manifest): Promise<ComputeResult<ArtifactEvidence>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([launcher.prepare(manifest, controller.signal), new Promise<ComputeResult<ArtifactEvidence>>((resolve) => {
      timer = setTimeout(() => { resolve(computeFailure("compute_timeout")); controller.abort(); }, 2000);
    })]);
  } finally { clearTimeout(timer); }
}
