// HTTP success contract for idempotent Principal revocation.
import { t } from "elysia";

export const revokedPrincipalResponse = t.Object({
  principalId: t.String({ format: "uuid" }),
  workspaceId: t.String({ format: "uuid" }),
  effectsPausedThisRequest: t.Integer({ minimum: 0 }),
  status: t.Literal("revoked"),
});
