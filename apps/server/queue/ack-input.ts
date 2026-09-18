// Ack contracts omit stored Receipt hashes and dispatch internals.
import { t } from "elysia";
import { receiptInput, deliveryParams } from "./receipt-input.ts";

export const ackInput = t.Object(receiptInput.properties, { additionalProperties: false });
export const ackParams = t.Object(deliveryParams.properties);
export const ackResponse = t.Object({
  deliveryId: t.String({ format: "uuid" }),
  state: t.Literal("succeeded"),
}, { additionalProperties: false });

export type Ack = typeof ackResponse.static;
