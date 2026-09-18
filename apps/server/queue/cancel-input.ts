// User cancel contracts expose the resulting Delivery envelope.
import { t } from "elysia";
import { deliveryParams } from "./receipt-input.ts";

export const cancelParams = t.Object(deliveryParams.properties);
export const cancelInput = t.Object({
  force: t.Boolean({ default: false }),
  reason: t.String({ pattern: "^[a-z][a-z0-9_]{0,63}$", minLength: 1, maxLength: 64 }),
}, { additionalProperties: false });
export type CancelInput = typeof cancelInput.static;
