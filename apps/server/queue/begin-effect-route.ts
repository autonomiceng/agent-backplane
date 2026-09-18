// Consumers record an Effect before acting outside the backplane.
import { Elysia, t } from "elysia";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { runSession } from "../runs/run-session.ts";
import { beginEffectInput, beginEffectParams, beginEffectResponse } from "./begin-effect-input.ts";
import { beginEffect } from "./begin-effect.ts";
import { queueErrorStatus } from "./queue-error.ts";

export function beginEffectRoute(pool: Pool) {
  return new Elysia({ name: "begin-effect" }).use(runSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/deliveries/:deliveryId/begin-effect",
    async ({ run, params, body, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await beginEffect(pool, run, params.deliveryId, body);
      if (!result.ok) return status(queueErrorStatus(result.reason), { error: result.reason });
      return result.effect;
    },
    {
      run: true,
      transform({ body, status }) {
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !Object.hasOwn(beginEffectInput.properties, key))) {
          throw status(422, { error: "invalid_input" });
        }
      },
      body: beginEffectInput,
      params: beginEffectParams,
      response: {
        200: beginEffectResponse,
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
      detail: { "x-backplane-auth": "principal", "x-backplane-run": "required", operationId: "beginEffect", tags: ["queue"] },
    },
  );
}
