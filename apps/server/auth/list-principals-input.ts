// User-facing Principal metadata and bounded Workspace pagination contract.
import { t } from "elysia";

export const listPrincipalsParams = t.Object({ workspaceId: t.String({ format: "uuid" }) });
export const listPrincipalsInput = t.Object({
  after: t.Optional(t.String({ minLength: 1, maxLength: 1024 })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 50 })),
}, { additionalProperties: false });
export const listPrincipalsResponse = t.Object({
  items: t.Array(t.Object({
    id: t.String({ format: "uuid" }),
    workspaceId: t.String({ format: "uuid" }),
    name: t.String(),
    status: t.Union([t.Literal("active"), t.Literal("revoked")]),
    credential: t.Nullable(t.Object({
      prefix: t.String(),
      createdAt: t.String({ format: "date-time" }),
      lastUsedAt: t.Nullable(t.String({ format: "date-time" })),
      rotatedAt: t.Nullable(t.String({ format: "date-time" })),
      revokedAt: t.Nullable(t.String({ format: "date-time" })),
    })),
  })),
  nextCursor: t.Nullable(t.String()),
});
export type ListPrincipalsInput = typeof listPrincipalsInput.static;
export type PrincipalsPage = typeof listPrincipalsResponse.static;
