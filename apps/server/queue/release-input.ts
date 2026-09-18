// User release contracts expose the resulting Delivery envelope.
import { t } from "elysia";
import { deliveryParams } from "./receipt-input.ts";

export const releaseParams = t.Object(deliveryParams.properties);
export const releaseInput = t.Object({}, { additionalProperties: false });
