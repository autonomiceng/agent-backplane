// Register under the Workspace cursor lock so ownership and retries are atomic.
import type { ComputeLauncher } from "./compute-launcher.ts";
import { computeFailure, computeSuccess, rollbackCompute, type ComputeResult } from "./compute-error.ts";
import type { deploymentResponse } from "./compute-input.ts";
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { compatibilityDate, configHash, normalizeUrls, sha256 } from "./deployment-config.ts";
import { liveFunctionKey, queryDeployment } from "./deployment-query.ts";
import type { deployFunctionInput } from "./deploy-function-input.ts";
export async function deployFunction(pool: Pool, context: Extract<RunContext, { principalId: string }>, name: string,
  input: typeof deployFunctionInput.static, launcher: ComputeLauncher | undefined): Promise<ComputeResult<{ created: boolean; metadata: typeof deploymentResponse.static }>> {
  const bundle = Buffer.from(input.bundle, "utf8");
  if (bundle.length > 4194304) return computeFailure("bundle_too_large");
  if (!bundle.length || bundle.toString("utf8") !== input.bundle) return computeFailure("bundle_invalid");
  const outboundUrls = normalizeUrls(input.outboundUrls);
  if (!outboundUrls) return computeFailure("invalid_input");
  const evidence = await launcher?.verify(AbortSignal.timeout(2000));
  if (!launcher || !evidence) return computeFailure("compute_unavailable");
  const { runtimeDigest } = launcher;
  const id = input.id.toLowerCase();
  const hash = configHash({ version: 1, ...context, functionName: name, id, bundle: input.bundle,
    bundleSha256: sha256(input.bundle), entryPoint: input.entryPoint, compatibilityDate, outboundUrls,
    keyRef: { workspaceId: context.workspaceId, principalId: context.principalId }, runtimeDigest });
  return withRunContext(pool, context, async (tx, emit) => {
    if (!await liveFunctionKey(tx, context.workspaceId, context.principalId)) return rollbackCompute(tx, "function_forbidden");
    const [owner] = await tx<{ principal_id: string }[]>`SELECT principal_id FROM control.functions
      WHERE workspace_id = ${context.workspaceId} AND name = ${name}`;
    if (owner && owner.principal_id !== context.principalId) return rollbackCompute(tx, "function_forbidden");
    const [existing] = await tx`SELECT id FROM control.deployments WHERE workspace_id = ${context.workspaceId} AND id = ${id}`;
    if (existing) {
      const deployment = await queryDeployment(tx, context.workspaceId, id);
      if (!deployment) throw new Error("deployment_missing_after_read");
      const { metadata } = deployment;
      if (metadata.functionName !== name || metadata.configHash !== hash) return rollbackCompute(tx, "deployment_conflict");
      return computeSuccess({ created: false, metadata });
    }
    if (!owner) await tx`INSERT INTO control.functions (workspace_id, name) VALUES (${context.workspaceId}, ${name})`;
    await tx`INSERT INTO control.deployments (workspace_id, function_name, id, bundle, entry_point,
      compatibility_date, outbound_urls, config_hash, runtime_digest) VALUES (${context.workspaceId}, ${name}, ${id}, ${bundle},
      ${input.entryPoint}, ${compatibilityDate}, ${tx.array(outboundUrls, "TEXT")}, ${Buffer.from(hash, "hex")}, ${runtimeDigest})`;
    await emit("function.deploy", [name, id], 1, { bundleSha256: sha256(input.bundle), configHash: hash, runtimeDigest, artifact: evidence.artifact });
    const deployment = await queryDeployment(tx, context.workspaceId, id);
    if (!deployment) throw new Error("deployment_missing_after_insert");
    return computeSuccess({ created: true, metadata: deployment.metadata });
  });
}
