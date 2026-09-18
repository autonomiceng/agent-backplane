// Approval routes share failure schemas, parse handling and strict body validation.
import { status, t, type ElysiaCustomStatusResponse } from "elysia";

export const approvalFailures = {
  400: t.Object({ error: t.String() }), 401: t.Object({ error: t.String() }),
  403: t.Object({ error: t.String() }), 404: t.Object({ error: t.String() }),
  409: t.Object({ error: t.String() }), 410: t.Object({ error: t.String() }),
  422: t.Object({ error: t.String() }), 503: t.Object({ error: t.String() }),
};
export type ApprovalValidationResult = ElysiaCustomStatusResponse<400, { error: string }>
  | ElysiaCustomStatusResponse<422, { error: string }> | undefined;
export function approvalValidation({ code }: { code: string | number }): ApprovalValidationResult {
  if (code === "PARSE") return status(400, { error: "invalid_json" });
  if (code === "VALIDATION") return status(422, { error: "invalid_input" });
}
export function strictApprovalBody(body: unknown, properties: object): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)
    || Object.keys(body).some((key) => !Object.hasOwn(properties, key))) throw status(422, { error: "invalid_input" });
}
