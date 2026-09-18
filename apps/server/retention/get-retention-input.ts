// GET retention returns the effective Workspace policy, including its default.
import { t } from "elysia";
export const getRetentionResponse = t.Object({ seconds: t.Integer({ minimum: 1, maximum: 31536000 }) }, { additionalProperties: false });
