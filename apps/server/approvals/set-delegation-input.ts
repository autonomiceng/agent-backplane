// Users grant or revoke one Workspace Principal's approval authority.
import { t } from "elysia";
import { approvalParams } from "./request-input.ts";
export const setDelegationInput = t.Object({ enabled: t.Boolean() }, { additionalProperties: false });
export const setDelegationParams = t.Object({ ...approvalParams.properties, principalId: t.String({ format: "uuid" }) });
export const setDelegationResponse = t.Object({ principalId: t.String({ format: "uuid" }), enabled: t.Boolean() });
