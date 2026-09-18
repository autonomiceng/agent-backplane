// HTTP send bounds request buffering and translates the transaction's idempotency outcome.
import { quotaResponse } from "../platform/quotas.ts";
import { Elysia, t } from "elysia";
import { validationError } from "../auth/validation-error.ts";
import type { Pool } from "../platform/pool.ts";
import { runSession } from "../runs/run-session.ts";
import { messageResponse, sendMessageInput, sendMessageParams } from "./send-message-input.ts";
import { sendMessage } from "./send-message.ts";

export function sendMessageRoute(pool: Pool) {
  return new Elysia({ name: "send-message" }).use(runSession(pool)).post(
    "/api/v1/workspaces/:workspaceId/queues/:queue/messages",
    async ({ run, params, body, status, set }) => {
      const result = await sendMessage(pool, run, params.queue, body);
      if (!result.ok && result.quota) {
        set.headers["retry-after"] = String(result.quota.retryAfterSeconds); set.headers["cache-control"] = "no-store";
        return status(429, result.quota);
      }
      if (!result.ok) {
        if (result.reason === "queue_not_found") return status(404, { error: result.reason });
        if (result.reason === "idempotency_conflict") return status(409, { error: result.reason });
        if (result.reason === "payload_too_large") return status(413, { error: result.reason });
        if (result.reason === "invalid_input") return status(422, { error: result.reason });
        return status(503, { error: result.reason });
      }
      return result.inserted ? status(201, result.message) : status(200, result.message);
    },
    {
      run: true,
      async parse({ request, status }, contentType) {
        if (contentType !== "application/json") throw status(422, { error: "invalid_input" });
        const reader = request.body?.getReader();
        if (!reader) throw status(422, { error: "invalid_input" });
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 524288) {
              await reader.cancel();
              throw status(413, { error: "payload_too_large" });
            }
            chunks.push(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        try {
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw status(422, { error: "invalid_input" });
        }
      },
      transform({ body, status }) {
        if (typeof body !== "object" || body === null || Array.isArray(body) || !Object.hasOwn(body, "payload")
          || Object.keys(body).some((key) => !Object.hasOwn(sendMessageInput.properties, key))) {
          throw status(422, { error: "invalid_input" });
        }
      },
      body: sendMessageInput,
      params: sendMessageParams,
      response: { 429: quotaResponse,
        200: messageResponse,
        201: messageResponse,
        400: t.Object({ error: t.String() }),
        401: t.Object({ error: t.String() }),
        403: t.Object({ error: t.String() }),
        404: t.Object({ error: t.String() }),
        409: t.Object({ error: t.String() }),
        413: t.Object({ error: t.String() }),
        422: t.Object({ error: t.String() }),
        503: t.Object({ error: t.String() }),
      },
      error: validationError,
      detail: { "x-backplane-auth": "principal", "x-backplane-run": "required", operationId: "sendMessage", tags: ["queue"] },
    },
  );
}
