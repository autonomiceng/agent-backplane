// Renew contracts omit stored Receipt hashes and dispatch internals.
import { t } from "elysia";
import { receiptInput, deliveryParams } from "./receipt-input.ts";

export const renewInput = t.Object(receiptInput.properties, { additionalProperties: false });
export const renewParams = t.Object(deliveryParams.properties);
export const renewResponse = t.Object({
  deliveryId: t.String({ format: "uuid" }),
  leaseExpiresAt: t.String({ format: "date-time" }),
}, { additionalProperties: false });

export type Renew = typeof renewResponse.static;
