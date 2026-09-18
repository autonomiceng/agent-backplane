// A Principal with a Run materializes a bounded batch of legacy Deliveries.
import { Elysia, t } from "elysia";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { runSession } from "../runs/run-session.ts";
import { recoverInput, recoverParams, recoverResponse } from "./recover-input.ts";
import { recover } from "./recover.ts";
import { queueErrorStatus } from "./queue-error.ts";

export function recoverRoute(pool: Pool) {
  return new Elysia({ name: "recover" }).use(runSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/queues/:queue/recover",
    async ({ run, params, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await recover(pool, run, params.queue);
      if (!result.ok) return status(queueErrorStatus(result.reason), { error: result.reason });
      return result.recovery;
    },
    {
      run: true,
      transform({ body, status }) {
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !Object.hasOwn(recoverInput.properties, key))) {
          throw status(422, { error: "invalid_input" });
        }
      },
      body: recoverInput,
      params: recoverParams,
      response: {
        200: recoverResponse,
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
      detail: { "x-backplane-auth": "principal", "x-backplane-run": "required", operationId: "recoverDeliveries", tags: ["queue"] },
    },
  );
}
