// Either actor reads the Workspace stream. Any Authorization header selects credentials and excludes cookie fallback.
import { Elysia, t } from "elysia";
import type { Auth } from "../auth/auth.ts";
import { decidePrincipalKey, parsePrincipalKey } from "../auth/principal-key.ts";
import { verifyPrincipalSecret } from "../auth/principal-key-crypto.ts";
import { queryPrincipalKey } from "../auth/principal-key-query.ts";
import { touchPrincipalKey } from "../auth/touch-principal-key.ts";
import { queryWorkspaceAccess } from "../auth/workspace-access-query.ts";
import type { Pool } from "../platform/pool.ts";
import { runParams } from "../runs/create-run-input.ts";
import { MAX_POSITION, readAuditInput, readAuditResponse } from "./read-audit-input.ts";
import { readAudit } from "./read-audit.ts";

export function readAuditRoute(pool: Pool, auth: Auth) {
  return new Elysia({ name: "read-audit" }).get(
    "/api/v1/workspaces/:workspaceId/audit",
    async ({ request, params, query, status }) => {
      if (query.after !== undefined && BigInt(query.after) > MAX_POSITION) return status(400, { error: "invalid_query" });
      try {
        if (request.headers.has("authorization")) {
          const key = parsePrincipalKey(request.headers.get("authorization"));
          if (!key) return status(401, { error: "unauthorized" });
          const row = await queryPrincipalKey(pool, key.prefix);
          const result = decidePrincipalKey(row, verifyPrincipalSecret(key.secret, row?.secretHash ?? null));
          if (result.status !== "authenticated") return status(401, { error: "unauthorized" });
          if (result.principal.workspaceId !== params.workspaceId.toLowerCase()) return status(403, { error: "workspace_forbidden" });
          await touchPrincipalKey(pool, key.prefix);
        } else {
          const session = await auth.api.getSession({ headers: request.headers });
          if (!session) return status(401, { error: "unauthorized" });
          const access = await queryWorkspaceAccess(pool, session.user.id, params.workspaceId);
          if (!access.allowed) return status(403, { error: access.reason });
        }
        return await readAudit(pool, params.workspaceId, { ...query, after: query.after ?? "0", limit: query.limit ?? 100 });
      } catch {
        return status(503, { error: "audit_read_failed" });
      }
    },
    {
      params: runParams,
      query: readAuditInput,
      response: {
        200: readAuditResponse,
        400: t.Object({ error: t.String() }),
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error({ code, status }) {
        if (code === "VALIDATION") return status(400, { error: "invalid_query" });
      },
      detail: { "x-backplane-auth": "either", "x-backplane-run": "none", operationId: "readAudit", tags: ["events"] },
    },
  );
}
