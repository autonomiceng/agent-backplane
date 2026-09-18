// HTTP wiring for decideApproval; adapters own authorization and the bound transaction.
import { Elysia } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "../auth/auth.ts";
import { decisionSession } from "../auth/decision-session.ts";
import { decideInput, decideParams, decideResponse } from "./decide-input.ts";
import { decideApproval } from "./decide.ts";
import { approvalErrorStatus } from "./approval-error.ts";
import { approvalFailures, approvalValidation, strictApprovalBody } from "./approval-input.ts";
export function decideRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "approval-decide" }).use(decisionSession(pool, auth, authUrl)).post(
    "/api/v1/workspaces/:workspaceId/approvals/:id/decision",
    async ({ actor, params, body, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await decideApproval(pool, actor, params.id, body);
      if (!result.ok) return status(approvalErrorStatus(result.reason), { error: result.reason });
      return status(200, result.value);
    },
    {
      approver: true,
      transform({ body }) { strictApprovalBody(body, decideInput.properties); },
      body: decideInput, params: decideParams, response: { 200: decideResponse, ...approvalFailures },
      error: approvalValidation, detail: { "x-backplane-auth": "either", "x-backplane-run": "principal-required", operationId: "decideApproval", tags: ["approvals"] },
    },
  );
}
