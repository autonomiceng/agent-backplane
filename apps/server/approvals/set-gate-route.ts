// HTTP wiring for setApprovalGate; adapters own authorization and the bound transaction.
import { Elysia } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "../auth/auth.ts";
import { userSession } from "../auth/user-session.ts";
import { setGateInput, setGateResponse } from "./set-gate-input.ts";
import { approvalParams } from "./request-input.ts";
import { setGate } from "./set-gate.ts";
import { approvalErrorStatus } from "./approval-error.ts";
import { approvalFailures, approvalValidation, strictApprovalBody } from "./approval-input.ts";
export function setGateRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "approval-set-gate" }).use(userSession(auth, authUrl)).put(
    "/api/v1/workspaces/:workspaceId/approvals/gates",
    async ({ user, params, body, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await setGate(pool, { workspaceId: params.workspaceId, userId: user.id }, body);
      if (!result.ok) return status(approvalErrorStatus(result.reason), { error: result.reason });
      return status(200, result.value);
    },
    {
      user: true,
      transform({ body, request, status }) {
        if (request.headers.has("authorization")) throw status(403, { error: "approval_forbidden" });
        strictApprovalBody(body, setGateInput.properties);
      },
      body: setGateInput, params: approvalParams, response: { 200: setGateResponse, ...approvalFailures },
      error: approvalValidation, detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "setApprovalGate", tags: ["approvals"] },
    },
  );
}
