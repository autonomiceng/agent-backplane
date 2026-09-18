// A Principal holds a leased Delivery with its Receipt and bound Run.
import { Elysia, t } from "elysia";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { runSession } from "../runs/run-session.ts";
import { holdInput, holdParams } from "./hold-input.ts";
import { deliveryEnvelope } from "./delivery-envelope.ts";
import { hold } from "./hold.ts";
import { queueErrorStatus } from "./queue-error.ts";

export function holdRoute(pool: Pool) {
  return new Elysia({ name: "hold" }).use(runSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/deliveries/:deliveryId/hold",
    async ({ run, params, body, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await hold(pool, run, params.deliveryId, body.receipt);
      if (!result.ok) return status(queueErrorStatus(result.reason), { error: result.reason });
      return result.delivery;
    },
    {
      run: true,
      transform({ body, status }) {
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !Object.hasOwn(holdInput.properties, key))) {
          throw status(422, { error: "invalid_input" });
        }
      },
      body: holdInput,
      params: holdParams,
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
      detail: { "x-backplane-auth": "principal", "x-backplane-run": "required", operationId: "holdDelivery", tags: ["queue"] },
    },
  );
}
