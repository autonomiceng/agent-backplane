// Operations verify before opening a transaction; each dispatch carries that observation for the loader to compare.
import { computeFailure, computeSuccess, type ComputeResult } from "./compute-error.ts";
import { readArtifactEvidence, readControlSurfaceHash, type ArtifactEvidence, type RuntimeEvidence } from "./runtime-identity.ts";
import type { Manifest } from "./deployment-config.ts";
export type Invocation = { manifest: Manifest; props: { token: string; runId: string; workspaceId: string }; input: unknown };
export type ComputeLauncher = { runtimeDigest: string; timeoutMs?: number; verify(signal: AbortSignal): Promise<RuntimeEvidence | null>; invoke?(invocation: Invocation, signal: AbortSignal, evidence: RuntimeEvidence): Promise<Response>; prepare(manifest: Manifest, signal: AbortSignal, evidence: RuntimeEvidence): Promise<ComputeResult<ArtifactEvidence>> };
export function createComputeLauncher(config: { url: string | undefined; token: string | undefined; runtimeDigest: string | undefined; timeoutMs?: string | undefined }): ComputeLauncher | undefined {
  if (!config.url) return undefined;
  const { token, runtimeDigest = "" } = config;
  const timeoutMs = config.timeoutMs === undefined ? 10000 : Number(config.timeoutMs);
  let endpoint: URL | undefined;
  try {
    const url = new URL(config.url);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    const privateHttp = url.protocol === "http:" && (loopback || url.hostname === "workerd" && url.port === "8080");
    if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647 && (url.protocol === "https:" || privateHttp) && !url.username && !url.password && !url.href.includes("?") && !url.href.includes("#") && token && /^workerd-binary-sha256:[0-9a-f]{64}$/.test(runtimeDigest)) {
      url.pathname = `${url.pathname.replace(/\/$/, "")}/prepare`;
      endpoint = url;
    }
  } catch { /* Invalid configuration disables compute operations without blocking core. */ }
  const verify = async (signal: AbortSignal) => {
    if (!endpoint) return null;
    try {
      const response = await fetch(new URL(endpoint.href.replace(/\/prepare$/, "/identity")), {
        headers: { authorization: `Bearer ${token}` }, signal, redirect: "error" });
      await response.body?.cancel();
      const controlHash = response.headers.get("x-backplane-control");
      if (response.status !== 204 || response.headers.get("x-backplane-runtime") !== runtimeDigest
        || !controlHash || controlHash !== await readControlSurfaceHash()) return null;
      const artifact = readArtifactEvidence(response.headers.get("x-backplane-artifact"));
      return artifact ? { runtimeDigest, controlHash, artifact } : null;
    } catch (error) {
      if (signal.aborted) throw error;
      return null;
    }
  };
  return { runtimeDigest, verify, timeoutMs: endpoint ? timeoutMs : 10000, async invoke(invocation, signal, evidence) {
    if (!endpoint || invocation.manifest.runtimeDigest !== runtimeDigest || evidence.runtimeDigest !== runtimeDigest) throw new Error("compute_unavailable");
    try {
      const response = await fetch(new URL(endpoint.href.replace(/\/prepare$/, "/invoke")), { method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
          "x-backplane-runtime": evidence.runtimeDigest, "x-backplane-control": evidence.controlHash, "x-backplane-artifact": JSON.stringify(evidence.artifact) },
        body: JSON.stringify(invocation), signal, redirect: "manual" });
      if (response.status === 503 && response.headers.get("x-backplane-error") === "compute_unavailable") {
        await response.body?.cancel();
        throw new Error("compute_unavailable");
      }
      return response;
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error("compute_unavailable");
    }
  }, async prepare(manifest, signal, evidence) {
    if (!endpoint || manifest.runtimeDigest !== runtimeDigest || evidence.runtimeDigest !== runtimeDigest) return computeFailure("compute_unavailable");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
        "x-backplane-runtime": evidence.runtimeDigest, "x-backplane-control": evidence.controlHash, "x-backplane-artifact": JSON.stringify(evidence.artifact) },
        body: JSON.stringify(manifest), signal, redirect: "error" });
      await response.body?.cancel();
      if (response.status === 422) return computeFailure("bundle_invalid");
      return response.status === 204 ? computeSuccess(evidence.artifact) : computeFailure("compute_unavailable");
    } catch (error) {
      if (signal.aborted) throw error;
      return computeFailure("compute_unavailable");
    }
  } };
}
export async function prepareDeployment(launcher: ComputeLauncher, manifest: Manifest, evidence: RuntimeEvidence): Promise<ComputeResult<ArtifactEvidence>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([launcher.prepare(manifest, controller.signal, evidence), new Promise<ComputeResult<ArtifactEvidence>>((resolve) => {
      timer = setTimeout(() => { resolve(computeFailure("compute_timeout")); controller.abort(); }, 2000);
    })]);
  } finally { clearTimeout(timer); }
}
