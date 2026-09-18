// Bound writers and authorized readers share the immutable deployment projection.
import type { Pool } from "../platform/pool.ts";
import type { RunTransaction } from "../runs/with-run-context.ts";
import type { deploymentResponse } from "./compute-input.ts";
export async function queryDeployment(tx: Pool | RunTransaction, workspaceId: string, id: string) {
  const [row] = await tx<(typeof deploymentResponse.static & { bundle: Buffer })[]>`SELECT workspace_id AS "workspaceId",
    function_name AS "functionName", id, bundle, encode(bundle_hash,'hex') AS "bundleSha256", size,
    entry_point AS "entryPoint", compatibility_date::text AS "compatibilityDate", outbound_urls AS "outboundUrls",
    encode(config_hash,'hex') AS "configHash", runtime_digest AS "runtimeDigest", principal_id AS "principalId",
    run_id AS "runId", created_at::text AS "createdAt", status FROM control.deployments
    WHERE workspace_id = ${workspaceId} AND id = ${id}`;
  if (!row) return null;
  const { bundle, ...metadata } = row;
  return { metadata, bundle: Buffer.from(bundle).toString("utf8") };
}
export async function liveFunctionKey(tx: RunTransaction, workspaceId: string, principalId: string): Promise<boolean> {
  const [key] = await tx`SELECT k.principal_id FROM control.principal_keys k JOIN control.principals p
    ON p.workspace_id = k.workspace_id AND p.id = k.principal_id WHERE k.workspace_id = ${workspaceId}
    AND k.principal_id = ${principalId} AND k.revoked_at IS NULL AND p.status = 'active' FOR SHARE OF k, p`;
  return Boolean(key);
}
