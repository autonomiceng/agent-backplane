// Queue creation contracts used by the route and adapter; physical storage stays private.
import { t } from "elysia";

export const createQueueInput = t.Object({
  name: t.String({ minLength: 1, maxLength: 63, pattern: "^[a-z][a-z0-9_-]{0,62}$" }),
}, { additionalProperties: false });
export const createQueueParams = t.Object({ workspaceId: t.String({ format: "uuid" }) });
export const queueResponse = t.Object({
  workspaceId: t.String({ format: "uuid" }),
  name: t.String(),
  createdAt: t.String({ format: "date-time" }),
}, { additionalProperties: false });

export type Queue = typeof queueResponse.static;
