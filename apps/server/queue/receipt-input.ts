// Shared fencing contract for renew, ack and nack requests.
import { t } from "elysia";

export const receiptInput = t.Object({ receipt: t.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false });
export const deliveryParams = t.Object({
  workspaceId: t.String({ format: "uuid" }),
  deliveryId: t.String({ format: "uuid" }),
});
