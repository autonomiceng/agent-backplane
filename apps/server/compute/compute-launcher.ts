// main.ts supplies configuration; compute adapters supply immutable manifests and abort signals.
import { computeFailure, computeSuccess, type ComputeResult } from "./compute-error.ts";
import type { Manifest } from "./deployment-config.ts";
export type Invocation = { manifest: Manifest; props: { token: string; runId: string; workspaceId: string }; input: unknown };
export type ComputeLauncher = { runtimeDigest: string; timeoutMs?: number; invoke?(invocation: Invocation, signal: AbortSignal): Promise<Response>; prepare(manifest: Manifest, signal: AbortSignal): Promise<ComputeResult<null>> };
export function createComputeLauncher(config: { url: string | undefined; token: string | undefined; runtimeDigest: string | undefined; timeoutMs?: string | undefined }): ComputeLauncher | undefined {
  if (!config.url) return undefined;
  const { token, runtimeDigest = "" } = config;
  const timeoutMs = config.timeoutMs === undefined ? 10000 : Number(config.timeoutMs);
  let endpoint: URL | undefined;
  try {
    const url = new URL(config.url);
    if (Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647 && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && token && /^[0-9a-f]{64}$/.test(runtimeDigest)) {
      endpoint = new URL(`${url.pathname.replace(/\/$/, "")}/prepare`, url);
    }
  } catch { /* Configuration failure is reported only by compute routes. */ }
  return { runtimeDigest, timeoutMs: endpoint ? timeoutMs : 10000, async invoke(invocation, signal) {
    if (!endpoint) throw new Error("compute_unavailable");
    return fetch(new URL(endpoint.href.replace(/\/prepare$/, "/invoke")), { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(invocation), signal, redirect: "manual" });
  }, async prepare(manifest, signal) {
    if (!endpoint) return computeFailure("compute_unavailable");
    const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(manifest), signal, redirect: "error" });
    await response.body?.cancel();
    if (response.status === 422) return computeFailure("bundle_invalid");
    return response.status === 204 ? computeSuccess(null) : computeFailure("compute_unavailable");
  } };
}
export async function prepareDeployment(launcher: ComputeLauncher, manifest: Manifest): Promise<ComputeResult<null>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([launcher.prepare(manifest, controller.signal), new Promise<ComputeResult<null>>((resolve) => {
      timer = setTimeout(() => { resolve(computeFailure("compute_timeout")); controller.abort(); }, 2000);
    })]);
  } finally { clearTimeout(timer); }
}
