// HTTP wiring for setApprovalDelegation; adapters own authorization and the bound transaction.
import { Elysia } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "../auth/auth.ts";
import { userSession } from "../auth/user-session.ts";
import { setDelegationInput, setDelegationParams, setDelegationResponse } from "./set-delegation-input.ts";
import { setDelegation } from "./set-delegation.ts";
import { approvalErrorStatus } from "./approval-error.ts";
import { approvalFailures, approvalValidation, strictApprovalBody } from "./approval-input.ts";
export function setDelegationRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "approval-set-delegation" }).use(userSession(auth, authUrl)).put(
    "/api/v1/workspaces/:workspaceId/approvals/delegations/:principalId",
    async ({ user, params, body, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await setDelegation(pool, { workspaceId: params.workspaceId, userId: user.id }, params.principalId, body.enabled);
      if (!result.ok) return status(approvalErrorStatus(result.reason), { error: result.reason });
      return status(200, result.value);
    },
    {
      user: true,
      transform({ body, request, status }) {
        if (request.headers.has("authorization")) throw status(403, { error: "approval_forbidden" });
        strictApprovalBody(body, setDelegationInput.properties);
      },
      body: setDelegationInput, params: setDelegationParams, response: { 200: setDelegationResponse, ...approvalFailures },
      error: approvalValidation, detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "setApprovalDelegation", tags: ["approvals"] },
    },
  );
}
