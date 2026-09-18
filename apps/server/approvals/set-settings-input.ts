// Missing settings keep self-approval disabled; Users control this single switch.
import { t } from "elysia";
export const setSettingsInput = t.Object({ allowSelfApproval: t.Boolean() }, { additionalProperties: false });
