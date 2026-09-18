// User sessions grant a separate authority from Approval delegation.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import { userSession } from "../auth/user-session.ts";
import type { Pool } from "../platform/pool.ts";
import { reconciliationFailures, reconciliationValidation } from "./reconcile-input.ts";
import { setReconciliationDelegationInput, setReconciliationDelegationParams, setReconciliationDelegationResponse } from "./set-reconciliation-delegation-input.ts";
import { setReconciliationDelegation } from "./set-reconciliation-delegation.ts";
import { queueErrorStatus } from "./queue-error.ts";
export function setReconciliationDelegationRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "set-reconciliation-delegation" }).use(userSession(auth, authUrl)).put(
    "/api/v1/workspaces/:workspaceId/reconciliations/delegations/:principalId",
    async ({ user, params, body, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await setReconciliationDelegation(pool, { workspaceId: params.workspaceId, userId: user.id }, params.principalId, body.enabled);
      if (!result.ok) return status(queueErrorStatus(result.reason), { error: result.reason });
      return status(200, result.value);
    },
    {
      user: true,
      transform({ body, request, status }) {
        if (request.headers.has("authorization")) throw status(403, { error: "reconciliation_forbidden" });
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !Object.hasOwn(setReconciliationDelegationInput.properties, key))) throw status(422, { error: "invalid_input" });
      },
      body: setReconciliationDelegationInput, params: setReconciliationDelegationParams,
      response: { 200: setReconciliationDelegationResponse, ...reconciliationFailures },
      error: reconciliationValidation, detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "setReconciliationDelegation", tags: ["queue"] },
    },
  );
}
