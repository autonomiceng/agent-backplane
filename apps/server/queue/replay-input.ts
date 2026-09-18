// User replay contracts expose the resulting Delivery envelope.
import { t } from "elysia";
import { deliveryParams } from "./receipt-input.ts";

export const replayParams = t.Object(deliveryParams.properties);
export const replayInput = t.Object({}, { additionalProperties: false });
export type ReplayInput = typeof replayInput.static;
