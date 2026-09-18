// Message lookup contracts used by the read adapter and route.
import { t } from "elysia";
import { messageResponse, sendMessageParams } from "./send-message-input.ts";

export const getMessageParams = t.Object({ ...sendMessageParams.properties, messageId: t.String({ format: "uuid" }) });
export const getMessageResponse = t.Object({ ...messageResponse.properties, payload: t.Unknown() }, { additionalProperties: false });

export type MessageWithPayload = typeof getMessageResponse.static;
