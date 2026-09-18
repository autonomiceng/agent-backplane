// Mixed actors authenticate here; the adapter enforces reconciliation-specific authority.
import { Elysia } from "elysia";
import type { Auth } from "../auth/auth.ts";
import { decisionSession } from "../auth/decision-session.ts";
import type { Pool } from "../platform/pool.ts";
import { reconcileInput, reconcileParams, reconcileResponse, reconciliationFailures, reconciliationValidation } from "./reconcile-input.ts";
import { reconcile } from "./reconcile.ts";
import { queueErrorStatus } from "./queue-error.ts";
export function reconcileRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "reconcile" }).use(decisionSession(pool, auth, authUrl)).post(
    "/api/v1/workspaces/:workspaceId/reconciliations",
    async ({ actor, body, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await reconcile(pool, actor, body);
      if (!result.ok) return status(queueErrorStatus(result.reason), { error: result.reason });
      return status(200, result.value);
    },
    {
      approver: true,
      transform({ body, status }) {
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !Object.hasOwn(reconcileInput.properties, key))
          || ("evidence" in body && typeof body.evidence === "string" && Buffer.byteLength(body.evidence, "utf8") > 4096)) {
          throw status(422, { error: "invalid_input" });
        }
      },
      body: reconcileInput, params: reconcileParams, response: { 200: reconcileResponse, ...reconciliationFailures },
      error: reconciliationValidation, detail: { "x-backplane-auth": "either", "x-backplane-run": "principal-required", operationId: "reconcileEffect", tags: ["queue"] },
    },
  );
}
