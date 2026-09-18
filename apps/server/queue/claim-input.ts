// Claim returns only consumer-facing identity, Receipt, lease and payload fields.
import { t } from "elysia";
import { sendMessageParams } from "./send-message-input.ts";

export const claimInput = t.Object({}, { additionalProperties: false });
export const claimParams = t.Object(sendMessageParams.properties);
export const claimResponse = t.Object({
  deliveryId: t.String({ format: "uuid" }),
  messageId: t.String({ format: "uuid" }),
  attempt: t.Integer({ minimum: 1 }),
  receipt: t.String(),
  leaseExpiresAt: t.String({ format: "date-time" }),
  payload: t.Unknown(),
}, { additionalProperties: false });

export type Claim = typeof claimResponse.static;
