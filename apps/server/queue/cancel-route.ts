// Organization Users authorize recovery; Authorization headers never fall back to a cookie.
import { Elysia, t } from "elysia";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import type { Auth } from "../auth/auth.ts";
import { userSession } from "../auth/user-session.ts";
import { deliveryEnvelope } from "./delivery-envelope.ts";
import { cancelInput, cancelParams } from "./cancel-input.ts";
import { cancel } from "./cancel.ts";
import { queueErrorStatus } from "./queue-error.ts";

export function cancelRoute(pool: Pool, auth: Auth, authUrl: string) {
  return new Elysia({ name: "cancel" }).use(userSession(auth, authUrl)).post(
    "/api/v1/workspaces/:workspaceId/deliveries/:deliveryId/cancel",
    async ({ user, params, body, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await cancel(pool, { workspaceId: params.workspaceId, userId: user.id }, params.deliveryId, body);
      if (!result.ok) return status(queueErrorStatus(result.reason), { error: result.reason });
      return result.delivery;
    },
    {
      user: true,
      transform({ body, request, status }) {
        if (request.headers.has("authorization")) throw status(403, { error: "recovery_forbidden" });
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !Object.hasOwn(cancelInput.properties, key))) {
          throw status(422, { error: "invalid_input" });
        }
      },
      body: cancelInput,
      params: cancelParams,
      response: {
        200: deliveryEnvelope,
        400: t.Object({ error: t.String() }),
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        404: t.Object({ error: t.String() }),
        409: t.Object({ error: t.String() }),
        410: t.Object({ error: t.String() }),
        413: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "user", "x-backplane-run": "none", operationId: "cancelDelivery", tags: ["queue"] },
    },
  );
}
