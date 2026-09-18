// Commits caller-authorized authority before dispatch; every execution outcome attempts closed terminal cleanup.
import { randomBytes, createHash } from "node:crypto";
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { queryDeployment } from "./deployment-query.ts";
import type { Manifest } from "./deployment-config.ts";
import type { ComputeLauncher } from "./compute-launcher.ts";
import { finishInvocation } from "./finish-invocation.ts";
import { InvocationError, readInvocationBytes, type invokeFunctionInput } from "./invoke-function-input.ts";
export async function invokeFunction(pool: Pool, caller: RunContext, name: string, body: typeof invokeFunctionInput.static, launcher: ComputeLauncher, signal: AbortSignal) {
  const timeoutMs = body.timeoutMs ?? launcher.timeoutMs ?? 10000;
  if (timeoutMs > (launcher.timeoutMs ?? 10000)) throw new InvocationError("invalid_input");
  if (!launcher.invoke) throw new InvocationError("compute_unavailable");
  const token = `bp_i_${randomBytes(32).toString("hex")}`, hash = createHash("sha256").update(token).digest();
  const started = performance.now();
  const invocation = await withRunContext(pool, caller, async (tx, emit) => {
    const [active] = await tx<{ id: string }[]>`SELECT id FROM control.deployments
      WHERE workspace_id=${caller.workspaceId} AND function_name=${name} AND status='active' FOR SHARE`;
    if (!active) throw new InvocationError("function_not_found");
    const deployment = await queryDeployment(tx, caller.workspaceId, active.id);
    if (!deployment || deployment.metadata.runtimeDigest !== launcher.runtimeDigest) throw new InvocationError("compute_unavailable");
    const [child] = await tx<{ runId: string; remainingMs: number }[]>`SELECT run_id AS "runId",remaining_ms AS "remainingMs"
      FROM control.create_invocation(${active.id},${hash},${timeoutMs})`;
    if (!child) throw new InvocationError("compute_unavailable");
    const m = deployment.metadata;
    const manifest: Manifest = { version: 1, workspaceId: caller.workspaceId, functionName: name, id: active.id,
      bundle: deployment.bundle, bundleSha256: m.bundleSha256, entryPoint: m.entryPoint, compatibilityDate: m.compatibilityDate,
      outboundUrls: m.outboundUrls, keyRef: { workspaceId: caller.workspaceId, principalId: m.principalId }, runtimeDigest: m.runtimeDigest, configHash: m.configHash };
    await emit("function.invoke", [name, active.id, child.runId], 1, { deploymentId: active.id, runId: child.runId });
    await tx`SELECT control.sweep_invocation_tokens()`;
    return { ...child, manifest };
  });
  const controller = new AbortController();
  const deadline = started + invocation.remainingMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let kind: "function.complete" | "function.fail" | "function.timeout" = "function.fail";
  let httpStatus: number | null = null;
  const abort = () => controller.abort(new InvocationError("function_failed"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      timer = setTimeout(() => controller.abort(new InvocationError("function_timeout")), Math.max(0, deadline - performance.now()));
    });
    if (signal.aborted) abort();
    const execute = async () => {
      if (performance.now() >= deadline) throw new InvocationError("function_timeout");
      controller.signal.throwIfAborted();
      const response = await launcher.invoke?.({ manifest: invocation.manifest,
        props: { token, runId: invocation.runId, workspaceId: caller.workspaceId }, input: body.input }, controller.signal);
      if (!response) throw new InvocationError("compute_unavailable");
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); controller.signal.throwIfAborted(); }
      httpStatus = response.status;
      const bytes = await readInvocationBytes(response.body, "function_response_too_large", controller.signal);
      controller.signal.throwIfAborted();
      try { return JSON.parse(bytes.toString("utf8")); } catch { throw new InvocationError("function_response_invalid"); }
    };
    const result: unknown = await Promise.race([execute(), stopped]);
    if (performance.now() >= deadline) throw new InvocationError("function_timeout");
    kind = httpStatus !== null && httpStatus < 400 ? "function.complete" : "function.fail";
    return { deploymentId: invocation.manifest.id, runId: invocation.runId, status: httpStatus ?? 500, result };
  } catch (error) {
    const failure = error instanceof InvocationError ? error
      : new InvocationError(error instanceof Error && error.message === "compute_unavailable" ? "compute_unavailable" : "function_failed");
    if (failure.reason === "function_timeout") kind = "function.timeout";
    throw failure;
  } finally {
    clearTimeout(timer); controller.abort(); signal.removeEventListener("abort", abort);
    await finishInvocation(pool, invocation.runId, kind, Math.min(2147483647, Math.ceil(performance.now() - started)), httpStatus);
  }
}
