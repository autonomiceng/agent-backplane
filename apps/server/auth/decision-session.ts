// Mixed decisions select credentials whenever Authorization is present; configuration uses userSession.
import { invocationCredential } from "./invocation-credential.ts";
import { principalAdmission } from "../platform/principal-admission.ts";
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import { decidePrincipalKey, parsePrincipalKey } from "../auth/principal-key.ts";
import { verifyPrincipalSecret } from "../auth/principal-key-crypto.ts";
import { queryPrincipalKey } from "../auth/principal-key-query.ts";
import { touchPrincipalKey } from "../auth/touch-principal-key.ts";
import type { Pool } from "../platform/pool.ts";
import type { RunContext } from "../runs/run-context.ts";
import type { RunTransaction } from "../runs/with-run-context.ts";
import { parseRunHeader } from "../runs/run-header.ts";
import { runAccess } from "../runs/run-access.ts";
import { queryRunAccess } from "../runs/run-access-query.ts";

export async function approvalMember(tx: RunTransaction, context: Extract<RunContext, { userId: string }>): Promise<string> {
  const [member] = await tx<{ id: string }[]>`SELECT m.id FROM control.member m JOIN control.workspaces w
    ON w.organization_id = m."organizationId" WHERE w.id = ${context.workspaceId}
    AND m."userId" = ${context.userId} ORDER BY m.id FOR SHARE OF m`;
  if (!member) throw new Error("workspace_forbidden");
  return member.id;
}
export function decisionSession(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "approval-decision-session" }).use(principalAdmission()).macro({
    approver: {
      async beforeHandle(context) {
        if ("actor" in context && typeof context.actor === "object" && context.actor !== null
          && "principalId" in context.actor && !await context.admission.acquire(context.request)) {
          return context.status(503, { error: "admission_unavailable" });
        }
      },
      async resolve({ request, params, status }) {
        if (!("workspaceId" in params) || typeof params.workspaceId !== "string") return status(422, { error: "invalid_input" });
        const workspaceId = params.workspaceId.toLowerCase();
        if (!request.headers.has("authorization")) {
          const origin = request.headers.get("origin");
          if ((origin !== null && origin !== new URL(authUrl).origin)
            || request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return status(403, { error: "origin_forbidden" });
          try {
            const session = await auth.api.getSession({ headers: request.headers });
            if (!session) return status(401, { error: "unauthorized" });
            const actor: RunContext = { workspaceId, userId: session.user.id };
            return { actor };
          } catch { return status(503, { error: "approval_unavailable" }); }
        }
        try {
          const invocation = await invocationCredential(pool, request, workspaceId);
          if (invocation) return "principal" in invocation
            ? { actor: { ...invocation.principal, runId: request.headers.get("x-backplane-run")?.toLowerCase() ?? "" } }
            : status(invocation.status, { error: invocation.reason });
        } catch { return status(503, { error: "principal_authentication_failed" }); }
        const key = parsePrincipalKey(request.headers.get("authorization"));
        if (!key) return status(401, { error: "unauthorized" });
        let principal;
        try {
          const row = await queryPrincipalKey(pool, key.prefix);
          const result = decidePrincipalKey(row, verifyPrincipalSecret(key.secret, row?.secretHash ?? null));
          if (result.status !== "authenticated") return status(401, { error: "unauthorized" });
          if (result.principal.workspaceId !== workspaceId) return status(403, { error: "workspace_forbidden" });
          await touchPrincipalKey(pool, key.prefix);
          principal = result.principal;
        } catch { return status(503, { error: "principal_authentication_failed" }); }
        const parsed = parseRunHeader(request.headers.get("x-backplane-run"));
        if (!parsed.ok) return status(400, { error: parsed.reason });
        try {
          if (!runAccess(principal, await queryRunAccess(pool, parsed.runId)).allowed) return status(403, { error: "run_forbidden" });
          const actor: RunContext = { ...principal, runId: parsed.runId };
          return { actor };
        } catch { return status(503, { error: "run_access_failed" }); }
      },
    },
  });
}
