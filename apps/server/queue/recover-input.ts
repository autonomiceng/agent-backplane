// Recovery is a bounded Run-authenticated backfill for Messages sent before Delivery materialization.
import { t } from "elysia";
import { sendMessageParams } from "./send-message-input.ts";

export const recoverParams = t.Object(sendMessageParams.properties);
export const recoverInput = t.Object({}, { additionalProperties: false });
export const recoverResponse = t.Object({
  created: t.Integer({ minimum: 0, maximum: 32 }),
  hasMore: t.Boolean(),
}, { additionalProperties: false });
export type Recover = typeof recoverResponse.static;
