// The transaction-local executor gathers facts for preview; S08 can reuse it inside its atomic apply transaction.
import type { SavepointSQL } from "bun";
import { Buffer } from "node:buffer";
import { parse } from "libpg-query";
import type { RunTransaction } from "../runs/with-run-context.ts";
import type { MigrationDecision } from "./migration-policy.ts";
import { installContract, verifyContract } from "./workspace-contract.ts";

type Plan = Extract<MigrationDecision, { ok: true }>;
type Facts = { tables: string[]; locks: { relation: string; modes: string[] }[]; elapsedMs: number };
class PreviewRollback extends Error {
  constructor(readonly facts: Facts) { super("preview_rollback"); }
}

export async function executeMigration(tx: RunTransaction, schema: string, sql: string, plan: Plan,
  mode: "preview" | "apply"): Promise<Facts> {
  const execute = async (tx: SavepointSQL) => {
    const started = performance.now();
    await tx`SELECT control.prepare_sql_roles()`;
    await tx`SELECT control.prepare_workspace_schema()`;
    await tx.unsafe("SET LOCAL ROLE bp_executor");
    await tx`SET LOCAL search_path = ${tx(schema)}`;
    await tx`REVOKE ALL ON SCHEMA ${tx(schema)} FROM PUBLIC`;
    await tx`GRANT USAGE ON SCHEMA ${tx(schema)} TO ${tx(`bp_${schema}`)}`;
    await tx`ALTER DEFAULT PRIVILEGES FOR ROLE bp_executor IN SCHEMA ${tx(schema)}
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${tx(`bp_${schema}`)}`;
    await tx`ALTER DEFAULT PRIVILEGES FOR ROLE bp_executor IN SCHEMA ${tx(schema)}
      GRANT USAGE, SELECT ON SEQUENCES TO ${tx(`bp_${schema}`)}`;
    await tx`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${tx(schema)} TO ${tx(`bp_${schema}`)}`;
    await tx`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${tx(schema)} TO ${tx(`bp_${schema}`)}`;
    await verifyContract(tx, schema);
    const raws = (await parse(sql)).stmts ?? [];
    const bytes = Buffer.from(sql);
    const locks = new Map<string, Set<string>>();
    const relationNames = new Map<number, string>();
    const tables = new Set(plan.tables);
    for (const [index, raw] of raws.entries()) {
      const before = await tx<{ oid: number; name: string; tableName: string | null }[]>`
        SELECT c.oid, c.relname AS name, t.relname AS "tableName" FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_index i ON i.indexrelid = c.oid
        LEFT JOIN pg_class t ON t.oid = i.indrelid WHERE n.nspname = ${schema}`;
      for (const relation of before) relationNames.set(relation.oid, relation.name);
      const drop = raw.stmt && "DropStmt" in raw.stmt ? raw.stmt.DropStmt : undefined;
      const comment = raw.stmt && "CommentStmt" in raw.stmt ? raw.stmt.CommentStmt : undefined;
      const indexTargets = drop?.removeType === "OBJECT_INDEX" ? drop.objects ?? []
        : comment?.objtype === "OBJECT_INDEX" && comment.object ? [comment.object] : [];
      for (const target of indexTargets) {
        const part = "List" in target ? target.List.items?.at(-1) : undefined;
        const name = part && "String" in part ? part.String.sval : undefined;
        const table = before.find((relation) => relation.name === name)?.tableName;
        if (table) tables.add(table);
      }
      const start = raw.stmt_location ?? 0;
      const statement = bytes.subarray(start, raw.stmt_len ? start + raw.stmt_len : undefined).toString();
      await tx.unsafe(statement);
      const after = await tx<{ oid: number; name: string; kind: string }[]>`SELECT c.oid, c.relname AS name, c.relkind AS kind
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${schema}`;
      for (const relation of after) {
        relationNames.set(relation.oid, relation.name);
        if (plan.statements[index]?.kind === "CreateStmt" && relation.kind === "r"
          && !before.some((old) => old.oid === relation.oid)) await installContract(tx, schema, relation.name);
      }
      const held = await tx<{ oid: number; mode: string }[]>`SELECT relation AS oid, mode FROM pg_locks
        WHERE pid = pg_backend_pid() AND granted AND locktype = 'relation'`;
      for (const lock of held) {
        const relation = relationNames.get(lock.oid);
        if (relation === undefined) continue;
        const modes = locks.get(relation) ?? new Set<string>();
        modes.add(lock.mode); locks.set(relation, modes);
      }
    }
    await verifyContract(tx, schema);
    await tx.unsafe("SET LOCAL ROLE NONE");
    return { tables: [...tables].sort(), locks: [...locks].sort(([a], [b]) => a.localeCompare(b)).map(([relation, modes]) => ({ relation, modes: [...modes].sort() })),
      elapsedMs: performance.now() - started };
  };
  if (mode === "apply") return execute(tx);
  try {
    await tx.savepoint(async (sp) => { throw new PreviewRollback(await execute(sp)); });
  } catch (error) {
    if (error instanceof PreviewRollback) return error.facts;
    throw error;
  }
  throw new Error("migration_unavailable");
}
