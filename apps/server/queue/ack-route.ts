// Run-authenticated ack translates fenced queue outcomes into the HTTP contract.
import { Elysia, t } from "elysia";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { runSession } from "../runs/run-session.ts";
import { ackInput, ackParams, ackResponse } from "./ack-input.ts";
import { ack } from "./ack.ts";
import { queueErrorStatus } from "./queue-error.ts";

export function ackRoute(pool: Pool) {
  return new Elysia({ name: "ack" }).use(runSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/deliveries/:deliveryId/ack",
    async ({ run, params, body, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await ack(pool, run, params.deliveryId, body.receipt);
      if (!result.ok) return status(queueErrorStatus(result.reason), { error: result.reason });
      return result.delivery;
    },
    {
      run: true,
      transform({ body, status }) {
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !Object.hasOwn(ackInput.properties, key))) {
          throw status(422, { error: "invalid_input" });
        }
      },
      body: ackInput,
      params: ackParams,
      response: {
        200: ackResponse,
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
      detail: { "x-backplane-auth": "principal", "x-backplane-run": "required", operationId: "ackDelivery", tags: ["queue"] },
    },
  );
}
