// Reconciliation targets a Delivery; evidence is bounded independently of character count.
import { status, t } from "elysia";
export const reconciliationOutcome = t.Union([t.Literal("applied"), t.Literal("not_applied"), t.Literal("unknown")]);
export const reconcileParams = t.Object({ workspaceId: t.String({ format: "uuid" }) });
export const reconcileInput = t.Object({
  deliveryId: t.String({ format: "uuid" }), outcome: reconciliationOutcome,
  evidence: t.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\u0000]+$" }),
}, { additionalProperties: false });
export const reconcileResponse = t.Object({
  id: t.String({ format: "uuid" }), deliveryId: t.String({ format: "uuid" }), outcome: reconciliationOutcome,
  successorDeliveryId: t.Nullable(t.String({ format: "uuid" })), decisionPosition: t.String({ pattern: "^[1-9][0-9]*$" }),
});
export const reconciliationFailures = {
  400: t.Object({ error: t.String() }), 401: t.Object({ error: t.String() }),
  403: t.Object({ error: t.String() }), 404: t.Object({ error: t.String() }),
  409: t.Object({ error: t.String() }), 410: t.Object({ error: t.String() }),
  413: t.Object({ error: t.String() }), 422: t.Object({ error: t.String() }), 503: t.Object({ error: t.String() }),
};
export function reconciliationValidation({ code }: { code: string | number }) {
  if (code === "PARSE") return status(400, { error: "invalid_json" });
  if (code === "VALIDATION") return status(422, { error: "invalid_input" });
}
