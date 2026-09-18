// Hold uses the shared Receipt contract and returns the public Delivery envelope.
import { t } from "elysia";
import { receiptInput, deliveryParams } from "./receipt-input.ts";

export const holdInput = t.Object(receiptInput.properties, { additionalProperties: false });
export const holdParams = t.Object(deliveryParams.properties);
