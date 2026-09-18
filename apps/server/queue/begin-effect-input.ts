// Begin Effect accepts logical identity; SQL derives the stable Message-level key.
import { t } from "elysia";
import { receiptInput, deliveryParams } from "./receipt-input.ts";

export const beginEffectInput = t.Object({
  ...receiptInput.properties,
  action: t.String({ minLength: 1, maxLength: 1024, pattern: "^[^\\u0000]+$" }),
  destination: t.String({ minLength: 1, maxLength: 1024, pattern: "^[^\\u0000]+$" }),
}, { additionalProperties: false });
export const beginEffectParams = t.Object(deliveryParams.properties);
export const beginEffectResponse = t.Object({
  deliveryId: t.String({ format: "uuid" }),
  messageId: t.String({ format: "uuid" }),
  effectKey: t.String({ pattern: "^[0-9a-f]{64}$" }),
  state: t.Literal("begun"),
  begunAt: t.String({ format: "date-time" }),
}, { additionalProperties: false });
export type BeginEffectInput = typeof beginEffectInput.static;
export type BeginEffect = typeof beginEffectResponse.static;
