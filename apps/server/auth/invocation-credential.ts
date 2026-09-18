// Session helpers share Run-bound invocation verification; the global scope guard also covers User-only routes.
import { createHash } from "node:crypto";
import type { Pool } from "../platform/pool.ts";
export function invocationScope(request: Request): boolean {
  const path = new URL(request.url).pathname.replace(/^\/api\/v1\/workspaces\/[^/]+/, "");
  return (request.method === "POST" && /^\/(sql|transactions|migrations(?:\/preview)?|queues(?:\/[^/]+\/(messages|claim|recover))?|deliveries\/[^/]+\/(ack|nack|renew|hold|begin-effect)|reconciliations|blobs)$/.test(path))
    || (request.method === "GET" && /^\/(migrations|queues\/[^/]+\/(messages\/[^/]+|deliveries)|blobs\/[^/]+)$/.test(path))
    || (request.method === "DELETE" && /^\/blobs\/[^/]+$/.test(path));
}
export function isInvocation(request: Request): boolean { return /^Bearer bp_i_/i.test(request.headers.get("authorization") ?? ""); }
export async function invocationCredential(pool: Pool, request: Request, workspaceId: string) {
  if (!isInvocation(request)) return null;
  const bearer = request.headers.get("authorization") ?? "";
  if (!/^Bearer bp_i_[0-9a-f]{64}$/.test(bearer)) return { status: 401, reason: "unauthorized" } as const;
  if (!invocationScope(request)) return { status: 403, reason: "invocation_scope_forbidden" } as const;
  const invocationHash = createHash("sha256").update(bearer.slice(7)).digest();
  const [row] = await pool<{ workspaceId: string; principalId: string; runId: string }[]>`
    SELECT r.workspace_id AS "workspaceId", r.principal_id AS "principalId", r.id AS "runId"
    FROM control.invocation_tokens t JOIN control.runs r ON r.id=t.run_id
    JOIN control.principals p ON (p.workspace_id,p.id)=(r.workspace_id,r.principal_id)
    JOIN control.principal_keys k ON (k.workspace_id,k.principal_id)=(p.workspace_id,p.id)
    JOIN control.restore_gate g ON g.singleton WHERE t.token_hash=${invocationHash}
      AND t.expires_at>clock_timestamp() AND p.status='active' AND k.revoked_at IS NULL
      AND NOT g.active AND t.restore_epoch IS NOT DISTINCT FROM g.epoch`;
  if (!row) return { status: 401, reason: "unauthorized" } as const;
  if (row.workspaceId !== workspaceId.toLowerCase()) return { status: 403, reason: "workspace_forbidden" } as const;
  if (request.headers.get("x-backplane-run")?.toLowerCase() !== row.runId) return { status: 403, reason: "run_forbidden" } as const;
  return { principal: { workspaceId: row.workspaceId, principalId: row.principalId, invocationHash } };
}
