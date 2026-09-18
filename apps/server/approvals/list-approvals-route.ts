// Inbox reads accept either actor without a Run and record authenticated key use.
import { Elysia, t } from "elysia";
import type { Auth } from "../auth/auth.ts";
import { eitherSession } from "../auth/either-session.ts";
import type { Pool } from "../platform/pool.ts";
import { listApprovalsInput, listApprovalsResponse } from "./list-approvals-input.ts";
import { approvalParams } from "./request-input.ts";
import { validationError } from "../auth/validation-error.ts";
import { listApprovals } from "./list-approvals.ts";

export function listApprovalsRoute(pool: Pool, auth: Auth) {
  return new Elysia({ name: "list-approvals" }).get(
    "/api/v1/workspaces/:workspaceId/approvals",
    async ({ request, params, query, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      try {
        const failure = await eitherSession(pool, auth, request, params.workspaceId);
        if (failure) return status(failure.status, { error: failure.reason });
        const result = await listApprovals(pool, params.workspaceId, query);
        if (!result.ok) return status(result.reason === "invalid_input" ? 422 : 503, { error: result.reason });
        return result.page;
      } catch {
        return status(503, { error: "approval_unavailable" });
      }
    },
    {
      params: approvalParams,
      query: listApprovalsInput,
      response: {
        200: listApprovalsResponse,
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "either", "x-backplane-run": "none", operationId: "listApprovals", tags: ["approvals"] },
    },
  );
}
