// Nack contracts omit stored Receipt hashes and dispatch internals.
import { t } from "elysia";
import { receiptInput, deliveryParams } from "./receipt-input.ts";

export const nackInput = t.Object(receiptInput.properties, { additionalProperties: false });
export const nackParams = t.Object(deliveryParams.properties);
export const nackResponse = t.Object({
  deliveryId: t.String({ format: "uuid" }),
  state: t.Union([t.Literal("scheduled"), t.Literal("dead-lettered"), t.Literal("ambiguous")]),
  nextAttemptAt: t.Nullable(t.String({ format: "date-time" })),
}, { additionalProperties: false });

export type Nack = typeof nackResponse.static;
