// Approval adapters use canonical action hashes and a shared HTTP target descriptor.
import { createHash } from "node:crypto";
import { t } from "elysia";
export const rowDescriptor = t.Object({ targetKind: t.Literal("row"), targetId: t.String(), targetVersion: t.String(),
  table: t.String(), primaryKey: t.String({ description: "Canonical typed primary key as PostgreSQL JSON text; preserve it verbatim." }) });
export type RowDescriptor = typeof rowDescriptor.static;
export class GateError extends Error {
  constructor(reason: string, readonly target?: RowDescriptor) { super(reason); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new GateError("invalid_input");
  return encoded;
}
export function actionHash(input: { statement: string; params: unknown[]; expectRows?: number }, targetId: string): string {
  return createHash("sha256").update(canonical({ version: 1, statement: input.statement, params: input.params,
    expectRows: input.expectRows, targetId })).digest("hex");
}
