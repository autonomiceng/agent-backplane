// Principal-authenticated Run creation is the only write endpoint that rejects a supplied Run header.
import { Elysia, t } from "elysia";
import { principalSession } from "../auth/principal-session.ts";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { createRun } from "./create-run.ts";
import { createRunInput, runParams, runResponse } from "./create-run-input.ts";

export function createRunRoute(pool: Pool) {
  return new Elysia({ name: "create-run" }).use(principalSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/runs",
    async ({ principal, body, status }) => {
      const result = await createRun(pool, principal, body);
      if (!result.ok) return result.reason === "run_creation_failed"
        ? status(503, { error: result.reason }) : status(403, { error: result.reason });
      return status(201, result.run);
    },
    {
      principal: true,
      // The parent app normalizes objects before schema validation, dropping unknown keys and reshaping Records.
      transform({ body, status }) {
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !Object.hasOwn(createRunInput.properties, key))
          || ("metadata" in body && (typeof body.metadata !== "object" || body.metadata === null || Array.isArray(body.metadata)))) {
          throw status(422, { error: "invalid_input" });
        }
      },
      beforeHandle({ request, status }) {
        if (request.headers.has("x-backplane-run")) return status(400, { error: "run_header_unexpected" });
      },
      body: createRunInput,
      params: runParams,
      response: {
        201: runResponse,
        400: t.Object({ error: t.String() }),
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "principal", "x-backplane-run": "forbidden", operationId: "createRun", tags: ["runs"] },
    },
  );
}
