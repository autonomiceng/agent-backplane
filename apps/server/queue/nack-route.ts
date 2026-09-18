// Run-authenticated nack translates fenced queue outcomes into the HTTP contract.
import { Elysia, t } from "elysia";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { runSession } from "../runs/run-session.ts";
import { nackInput, nackParams, nackResponse } from "./nack-input.ts";
import { nack } from "./nack.ts";
import { queueErrorStatus } from "./queue-error.ts";

export function nackRoute(pool: Pool) {
  return new Elysia({ name: "nack" }).use(runSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/deliveries/:deliveryId/nack",
    async ({ run, params, body, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await nack(pool, run, params.deliveryId, body.receipt);
      if (!result.ok) return status(queueErrorStatus(result.reason), { error: result.reason });
      return result.delivery;
    },
    {
      run: true,
      transform({ body, status }) {
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !Object.hasOwn(nackInput.properties, key))) {
          throw status(422, { error: "invalid_input" });
        }
      },
      body: nackInput,
      params: nackParams,
      response: {
        200: nackResponse,
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
      detail: { "x-backplane-auth": "principal", "x-backplane-run": "required", operationId: "nackDelivery", tags: ["queue"] },
    },
  );
}
