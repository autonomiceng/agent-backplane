// HTTP wiring for setApprovalSettings; adapters own authorization and the bound transaction.
import { Elysia } from "elysia";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "../auth/auth.ts";
import { userSession } from "../auth/user-session.ts";
import { setSettingsInput } from "./set-settings-input.ts";
import { approvalParams } from "./request-input.ts";
import { setSettings } from "./set-settings.ts";
import { approvalErrorStatus } from "./approval-error.ts";
import { approvalFailures, approvalValidation, strictApprovalBody } from "./approval-input.ts";
export function setSettingsRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "approval-set-settings" }).use(userSession(auth, authUrl)).put(
    "/api/v1/workspaces/:workspaceId/approvals/settings",
    async ({ user, params, body, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await setSettings(pool, { workspaceId: params.workspaceId, userId: user.id }, body.allowSelfApproval);
      if (!result.ok) return status(approvalErrorStatus(result.reason), { error: result.reason });
      return status(200, result.value);
    },
    {
      user: true,
      transform({ body, request, status }) {
        if (request.headers.has("authorization")) throw status(403, { error: "approval_forbidden" });
        strictApprovalBody(body, setSettingsInput.properties);
      },
      body: setSettingsInput, params: approvalParams, response: { 200: setSettingsInput, ...approvalFailures },
      error: approvalValidation, detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "setApprovalSettings", tags: ["approvals"] },
    },
  );
}
