// Either-actor reads authorize Workspace access; invocation credentials also require their exact Run.
import { invocationCredential } from "./invocation-credential.ts";
import type { Auth } from "./auth.ts";
import type { Pool } from "../platform/pool.ts";
import { decidePrincipalKey, parsePrincipalKey } from "./principal-key.ts";
import { verifyPrincipalSecret } from "./principal-key-crypto.ts";
import { queryPrincipalKey } from "./principal-key-query.ts";
import { touchPrincipalKey } from "./touch-principal-key.ts";
import { queryWorkspaceAccess } from "./workspace-access-query.ts";

export async function eitherSession(pool: Pool, auth: Auth, request: Request, workspaceId: string): Promise<
  { status: 401; reason: "unauthorized" } | { status: 403; reason: "workspace_forbidden" | "run_forbidden" | "invocation_scope_forbidden" } | null
> {
  const invocation = await invocationCredential(pool, request, workspaceId);
  if (invocation) return "principal" in invocation ? null : invocation;
  if (request.headers.has("authorization")) {
    const key = parsePrincipalKey(request.headers.get("authorization"));
    if (!key) return { status: 401, reason: "unauthorized" };
    const row = await queryPrincipalKey(pool, key.prefix);
    const result = decidePrincipalKey(row, verifyPrincipalSecret(key.secret, row?.secretHash ?? null));
    if (result.status !== "authenticated") return { status: 401, reason: "unauthorized" };
    if (result.principal.workspaceId !== workspaceId.toLowerCase()) return { status: 403, reason: "workspace_forbidden" };
    await touchPrincipalKey(pool, key.prefix);
  } else {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return { status: 401, reason: "unauthorized" };
    const access = await queryWorkspaceAccess(pool, session.user.id, workspaceId);
    if (!access.allowed) return { status: 403, reason: access.reason };
  }
  return null;
}
