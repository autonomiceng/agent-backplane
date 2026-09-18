// HTTP contract for Run creation; caller facts stay in the Run row, outside audit envelopes.
import { t } from "elysia";

export const createRunInput = t.Object({
  harness: t.Optional(t.String({ maxLength: 256 })),
  model: t.Optional(t.String({ maxLength: 256 })),
  label: t.Optional(t.String({ maxLength: 256 })),
  metadata: t.Optional(t.Record(t.String(), t.Unknown())),
}, { additionalProperties: false });
export const runParams = t.Object({ workspaceId: t.String({ format: "uuid" }) });
export const runResponse = t.Object({
  id: t.String({ format: "uuid" }),
  workspaceId: t.String({ format: "uuid" }),
  principalId: t.String({ format: "uuid" }),
  harness: t.Nullable(t.String()),
  model: t.Nullable(t.String()),
  label: t.Nullable(t.String()),
  metadata: t.Record(t.String(), t.Unknown()),
  createdAt: t.String({ format: "date-time" }),
  lastSeenAt: t.String({ format: "date-time" }),
});

export type NewRun = typeof createRunInput.static;
export type Run = typeof runResponse.static;
