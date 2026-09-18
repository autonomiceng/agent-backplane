// PUT retention accepts the same bounded policy returned by GET.
import { t } from "elysia";
import { getRetentionResponse } from "./get-retention-input.ts";
export const setRetentionInput = t.Object(getRetentionResponse.properties, { additionalProperties: false });
