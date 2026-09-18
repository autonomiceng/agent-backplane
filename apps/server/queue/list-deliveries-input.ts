// Delivery listing uses a scoped cursor and a bounded live state filter.
import { t } from "elysia";
import { deliveryEnvelope } from "./delivery-envelope.ts";
import { deliveryState } from "./delivery-result.ts";
import { sendMessageParams } from "./send-message-input.ts";

export const listDeliveriesParams = t.Object(sendMessageParams.properties);
export const listDeliveriesInput = t.Object({
  state: t.Optional(deliveryState),
  after: t.Optional(t.String({ minLength: 1, maxLength: 1024 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 50 })),
}, { additionalProperties: false });
export const listDeliveriesResponse = t.Object({
  items: t.Array(deliveryEnvelope),
  nextCursor: t.Nullable(t.String()),
}, { additionalProperties: false });
export type ListDeliveriesInput = typeof listDeliveriesInput.static;
export type ListDeliveries = typeof listDeliveriesResponse.static;
