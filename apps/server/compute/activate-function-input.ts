// Activation uses compare-and-swap against the committed active deployment.
import { t } from "elysia";
export const activateFunctionInput = t.Object({ expectedActiveId: t.Nullable(t.String({ format: "uuid" })) }, { additionalProperties: false });
