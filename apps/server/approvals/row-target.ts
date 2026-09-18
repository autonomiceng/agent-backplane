// Request, decision and execution adapters lock catalog-derived row targets through the executor definer.
import type { RunTransaction } from "../runs/with-run-context.ts";
import type { PreparedSql } from "../sql/prepare-sql.ts";
import { gatedProposal } from "./proposal-policy.ts";
import { GateError, type RowDescriptor } from "./gate-policy.ts";
export function rowTable(workspaceId: string, table: string): string {
  const prefix = `ws_${workspaceId.replaceAll("-", "")}.`;
  return table.startsWith(prefix) ? table.slice(prefix.length) : table;
}
export async function rowTarget(tx: RunTransaction, workspaceId: string, table: string, key: Record<string, unknown> | string) {
  const [row] = await tx<(RowDescriptor & { epoch: string; oid: string; columns: string[] })[]>`
    SELECT d->>'targetKind' AS "targetKind", d->>'targetId' AS "targetId", d->>'targetVersion' AS "targetVersion",
      d->>'table' AS table, d->>'primaryKey' AS "primaryKey", d->>'epoch' AS epoch,
      d->>'oid' AS oid, ARRAY(SELECT jsonb_array_elements_text(d->'columns')) AS columns
    FROM control.lock_approval_row(${workspaceId}, ${rowTable(workspaceId, table)}, ${typeof key === "string" ? key : JSON.stringify(key)}::text::jsonb) d`;
  if (!row) throw new GateError("approval_target_not_found");
  return row;
}
export async function proposalTarget(tx: RunTransaction, workspaceId: string, prepared: PreparedSql) {
  const table = prepared.decision.writeTable;
  if (!table) throw new GateError("approval_target_unsupported");
  const [catalog] = await tx<{ columns: string[]; temporal: string[] }[]>`SELECT ARRAY(SELECT jsonb_array_elements_text(d->'columns')) AS columns,
      ARRAY(SELECT jsonb_array_elements_text(d->'temporal')) AS temporal
    FROM control.lock_approval_row(${workspaceId}, ${table}) d`;
  if (!catalog) throw new GateError("approval_target_unsupported");
  const key = await gatedProposal(prepared.input.statement, prepared.input.params, table, catalog.columns, catalog.temporal);
  if (!key) throw new GateError("approval_target_unsupported");
  return rowTarget(tx, workspaceId, table, key);
}
