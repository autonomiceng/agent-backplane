// Principal-authenticated Message inspection reads storage without creating a Delivery.
import { Elysia, t } from "elysia";
import { principalSession } from "../auth/principal-session.ts";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { getMessageParams, getMessageResponse } from "./get-message-input.ts";
import { getMessage } from "./get-message.ts";

export function getMessageRoute(pool: Pool) {
  return new Elysia({ name: "get-message" }).use(principalSession(pool)).get(
    "/api/v1/workspaces/:workspaceId/queues/:queue/messages/:messageId",
    async ({ principal, params, status, set }) => {
      set.headers["Cache-Control"] = "no-store";
      const result = await getMessage(pool, principal.workspaceId, params.queue, params.messageId);
      if (!result.ok) {
        if (result.reason === "payload_expired") return status(410, { error: result.reason });
        if (result.reason === "message_not_found" || result.reason === "queue_not_found") return status(404, { error: result.reason });
        return status(503, { error: result.reason });
      }
      return result.message;
    },
    {
      principal: true,
      params: getMessageParams,
      response: {
        200: getMessageResponse,
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        404: t.Object({ error: t.String() }),
        410: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "principal", "x-backplane-run": "none", operationId: "getMessage", tags: ["queue"] },
    },
  );
}
