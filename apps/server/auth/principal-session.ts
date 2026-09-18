// Agent routes opt into a fresh Workspace-scoped key lookup; User cookies are never consulted.
import { invocationCredential } from "./invocation-credential.ts";
import { principalAdmission } from "../platform/principal-admission.ts";
import { Elysia } from "elysia";
import type { Pool } from "../platform/pool.ts";
import { decidePrincipalKey, parsePrincipalKey } from "./principal-key.ts";
import { verifyPrincipalSecret } from "./principal-key-crypto.ts";
import { queryPrincipalKey } from "./principal-key-query.ts";
import { touchPrincipalKey } from "./touch-principal-key.ts";

export function principalSession(pool: Pool) {
  return new Elysia({ name: "principal-session" }).use(principalAdmission()).macro({
    principal: {
      async beforeHandle({ request, admission, status }) {
        if (!await admission.acquire(request)) return status(503, { error: "admission_unavailable" });
      },
      async resolve({ request, params, status }) {
        try {
          const invocation = await invocationCredential(pool, request, "workspaceId" in params ? String(params.workspaceId) : "");
          if (invocation) return "principal" in invocation ? { principal: invocation.principal } : status(invocation.status, { error: invocation.reason });
        } catch { return status(503, { error: "principal_authentication_failed" }); }
        const key = parsePrincipalKey(request.headers.get("authorization"));
        if (!key) return status(401, { error: "unauthorized" });
        try {
          const row = await queryPrincipalKey(pool, key.prefix);
          const result = decidePrincipalKey(row, verifyPrincipalSecret(key.secret, row?.secretHash ?? null));
          if (result.status !== "authenticated") return status(401, { error: "unauthorized" });
          if (!("workspaceId" in params) || typeof params.workspaceId !== "string"
            || params.workspaceId.toLowerCase() !== result.principal.workspaceId) return status(403, { error: "workspace_forbidden" });
          await touchPrincipalKey(pool, key.prefix);
          return { principal: result.principal };
        } catch {
          return status(503, { error: "principal_authentication_failed" });
        }
      },
    },
  });
}
