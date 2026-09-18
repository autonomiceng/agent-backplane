// HTTP contract for the Run-bound SQL route; parameters and rows never enter audit envelopes.
import { rowDescriptor } from "../approvals/gate-policy.ts";
import { t } from "elysia";

export const executeSqlInput = t.Object({
  statement: t.String({ minLength: 1, maxLength: 65536 }),
  params: t.Array(t.Unknown(), { maxItems: 100 }),
}, { additionalProperties: false });
export const executeSqlResponse = t.Object({
  rows: t.Array(t.Record(t.String(), t.Unknown())),
  rowCount: t.String(),
  truncated: t.Boolean(),
});
export const sqlErrorResponse = t.Object({ error: t.String(), target: t.Optional(rowDescriptor), sqlstate: t.Optional(t.String()) });
export type SqlInput = typeof executeSqlInput.static;
export type SqlResponse = typeof executeSqlResponse.static;
