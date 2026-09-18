// Both outcomes require a bounded machine code; free text never enters permanent metadata.
import { t } from "elysia";
import { approvalParams } from "./request-input.ts";
export const decision = t.Union([t.Literal("approve"), t.Literal("reject")]);
export const decideInput = t.Object({ decision, reason: t.String({ pattern: "^[a-z][a-z0-9_]{0,63}$", maxLength: 64 }) }, { additionalProperties: false });
export const decideParams = t.Object({ ...approvalParams.properties, id: t.String({ format: "uuid" }) });
export const decideResponse = t.Object({ id: t.String({ format: "uuid" }), decision, releasedDeliveryId: t.Nullable(t.String({ format: "uuid" })) });
