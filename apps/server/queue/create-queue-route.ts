// Principal and Run macros authorize Queue creation before the adapter binds its transaction.
import { Elysia, t } from "elysia";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { runSession } from "../runs/run-session.ts";
import { createQueueInput, createQueueParams, queueResponse } from "./create-queue-input.ts";
import { createQueue } from "./create-queue.ts";

export function createQueueRoute(pool: Pool) {
  return new Elysia({ name: "create-queue" }).use(runSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/queues",
    async ({ run, body, status }) => {
      const result = await createQueue(pool, run, body.name);
      if (!result.ok) {
        if (result.reason === "queue_exists") return status(409, { error: result.reason });
        if (result.reason === "invalid_input") return status(422, { error: result.reason });
        return status(503, { error: result.reason });
      }
      return status(201, result.queue);
    },
    {
      run: true,
      transform({ body, status }) {
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !Object.hasOwn(createQueueInput.properties, key))) {
          throw status(422, { error: "invalid_input" });
        }
      },
      body: createQueueInput,
      params: createQueueParams,
      response: {
        201: queueResponse,
        400: t.Object({ error: t.String() }),
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        409: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "principal", "x-backplane-run": "required", operationId: "createQueue", tags: ["queue"] },
    },
  );
}
