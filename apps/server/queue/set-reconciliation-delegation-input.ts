// Only Users may grant reconciliation authority to a Workspace Principal.
import { t } from "elysia";
import { reconcileParams } from "./reconcile-input.ts";
export const setReconciliationDelegationInput = t.Object({ enabled: t.Boolean() }, { additionalProperties: false });
export const setReconciliationDelegationParams = t.Object({ ...reconcileParams.properties, principalId: t.String({ format: "uuid" }) });
export const setReconciliationDelegationResponse = t.Object({ principalId: t.String({ format: "uuid" }), enabled: t.Boolean() });
