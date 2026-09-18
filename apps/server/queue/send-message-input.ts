// Send contracts expose immutable Message identity and provenance, without dispatch details.
import { t } from "elysia";
import { createQueueInput, createQueueParams } from "./create-queue-input.ts";

export const sendMessageInput = t.Object({
  idempotencyKey: t.String({ minLength: 1, maxLength: 256 }),
  payload: t.Unknown(),
}, { additionalProperties: false });
export const sendMessageParams = t.Object({ ...createQueueParams.properties, queue: createQueueInput.properties.name });
export const messageResponse = t.Object({
  id: t.String({ format: "uuid" }),
  workspaceId: t.String({ format: "uuid" }),
  queue: t.String(),
  idempotencyKey: t.String(),
  producerPrincipalId: t.String({ format: "uuid" }),
  producerRunId: t.String({ format: "uuid" }),
  createdAt: t.String({ format: "date-time" }),
}, { additionalProperties: false });

export type SendMessageInput = typeof sendMessageInput.static;
export type Message = typeof messageResponse.static;
