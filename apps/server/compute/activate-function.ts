// Preparation precedes the committed eligibility transition; cached isolates never authorize execution.
import { computeSuccess, rollbackCompute, type ComputeResult } from "./compute-error.ts";
import type { deploymentResponse } from "./compute-input.ts";
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { approvalMember } from "../auth/decision-session.ts";
import { prepareDeployment, type ComputeLauncher } from "./compute-launcher.ts";
import { liveFunctionKey, queryDeployment } from "./deployment-query.ts";
import type { Manifest } from "./deployment-config.ts";
export function activateFunction(pool: Pool, context: RunContext, name: string, id: string, expectedActiveId: string | null, launcher: ComputeLauncher): Promise<ComputeResult<typeof deploymentResponse.static>> {
  return withRunContext(pool, context, async (tx, emit) => {
    if ("userId" in context) {
      try { await approvalMember(tx, context); }
      catch (error) {
        if (error instanceof Error && error.message === "workspace_forbidden") return rollbackCompute(tx, "workspace_forbidden");
        throw error;
      }
    }
    const deployment = await queryDeployment(tx, context.workspaceId, id);
    if (!deployment) return rollbackCompute(tx, "deployment_not_found");
    const { metadata, bundle } = deployment;
    if (metadata.functionName !== name) return rollbackCompute(tx, "deployment_not_found");
    if ("principalId" in context && metadata.principalId !== context.principalId) return rollbackCompute(tx, "function_forbidden");
    if (!await liveFunctionKey(tx, context.workspaceId, metadata.principalId)) return rollbackCompute(tx, "function_forbidden");
    if (metadata.runtimeDigest !== launcher.runtimeDigest) return rollbackCompute(tx, "compute_unavailable");
    if (metadata.status === "retired") return rollbackCompute(tx, "deployment_retired");
    const [active] = await tx<{ id: string }[]>`SELECT id FROM control.deployments WHERE workspace_id = ${context.workspaceId}
      AND function_name = ${name} AND status = 'active'`;
    if (metadata.status !== "active" && (active?.id ?? null) !== (expectedActiveId?.toLowerCase() ?? null)) return rollbackCompute(tx, "activation_conflict");
    const prepared: Manifest = { version: 1, workspaceId: context.workspaceId, functionName: name, id, bundle,
      bundleSha256: metadata.bundleSha256, entryPoint: metadata.entryPoint, compatibilityDate: metadata.compatibilityDate,
      outboundUrls: metadata.outboundUrls, keyRef: { workspaceId: context.workspaceId, principalId: metadata.principalId },
      runtimeDigest: metadata.runtimeDigest, configHash: metadata.configHash };
    const preparation = await prepareDeployment(launcher, prepared);
    if (!preparation.ok) return rollbackCompute(tx, preparation.reason);
    if (metadata.status === "active") return computeSuccess(metadata);
    if (active) await tx`UPDATE control.deployments SET status = 'retired' WHERE workspace_id = ${context.workspaceId} AND id = ${active.id}`;
    await tx`UPDATE control.deployments SET status = 'active' WHERE workspace_id = ${context.workspaceId} AND id = ${id}`;
    await emit("function.activate", [name, id], 1, { deploymentId: id, previousActiveId: active?.id ?? null });
    return computeSuccess({ ...metadata, status: "active" });
  });
}
