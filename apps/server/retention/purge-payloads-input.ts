// Purge bounds the physical rows touched and returns counts without capture contents.
import { t } from "elysia";
export const purgeInput = t.Object({ limit: t.Optional(t.Integer({ minimum: 1, maximum: 100, default: 100 })) }, { additionalProperties: false });
export const purgeResponse = t.Object({ counts: t.Object({ queueBodies: t.Integer(), archiveRows: t.Integer(),
  migrationSql: t.Integer(), reconciliationEvidence: t.Integer(), blobs: t.Integer() }), hasMore: t.Boolean(), cleanupPending: t.Boolean() });
