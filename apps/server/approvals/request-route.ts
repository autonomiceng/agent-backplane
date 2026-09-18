// HTTP wiring for requestMessageApproval; adapters own authorization and the bound transaction.
import { Elysia } from "elysia";
import type { Pool } from "../platform/pool.ts";
import { runSession } from "../runs/run-session.ts";
import { requestInput, messageRequestInput, rowRequestInput, migrationRequestInput, approvalParams, requestResponse } from "./request-input.ts";
import { requestApproval } from "./request.ts";
import { approvalErrorStatus } from "./approval-error.ts";
import { approvalFailures, approvalValidation, strictApprovalBody } from "./approval-input.ts";
export function requestRoute(pool: Pool) {
  return new Elysia({ name: "approval-request" }).use(runSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/approvals",
    async ({ run, body, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await requestApproval(pool, run, body);
      if (!result.ok) return status(approvalErrorStatus(result.reason), { error: result.reason });
      return status(201, result.value);
    },
    {
      run: true,
      transform({ body }) {
        strictApprovalBody(body, { ...messageRequestInput.properties, ...rowRequestInput.properties, ...migrationRequestInput.properties });
        strictApprovalBody(body, "targetKind" in body ? body.targetKind === "migration" ? migrationRequestInput.properties : rowRequestInput.properties : messageRequestInput.properties);
        if ("sql" in body) strictApprovalBody(body.sql, rowRequestInput.properties.sql.properties); },
      body: requestInput, params: approvalParams, response: { 201: requestResponse, ...approvalFailures },
      error: approvalValidation, detail: { "x-backplane-auth": "principal", "x-backplane-run": "required", operationId: "requestMessageApproval", tags: ["approvals"] },
    },
  );
}
