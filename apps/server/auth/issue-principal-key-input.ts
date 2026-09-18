// HTTP contract for credential issuance and the shared Principal address.
import { t } from "elysia";

export const principalKeyParams = t.Object({
  workspaceId: t.String({ format: "uuid" }),
  principalId: t.String({ format: "uuid" }),
});
export const issuedPrincipalKeyResponse = t.Object({
  key: t.String(),
  prefix: t.String(),
  createdAt: t.String({ format: "date-time" }),
  rotatedAt: t.Nullable(t.String({ format: "date-time" })),
});
