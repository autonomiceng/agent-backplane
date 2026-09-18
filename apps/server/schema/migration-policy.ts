// Migration preview validates every statement before borrowing a transaction; DML shares S06's policy.
import { Buffer } from "node:buffer";
import { parse, scan } from "libpg-query";
import { statementPolicy } from "../sql/statement-policy.ts";

export type MigrationStatement = { kind: string; target: string; destructive: boolean };
export type MigrationDecision =
  | { ok: true; statements: MigrationStatement[]; destructive: boolean; tables: string[] }
  | { ok: false; reason: "migration_statement_forbidden" | "migration_syntax_error" | "migration_reserved_column" | "migration_too_many_statements"; statementIndex: number };
const types = new Set(["text", "int4", "int8", "numeric", "bool", "uuid", "jsonb", "timestamptz", "date", "bytea"]);
const operators = new Set("= <> < <= > >= + - * / % || -> ->> @> ?".split(" "));
const functions = new Set(["count", "sum", "min", "max", "avg", "jsonb_agg", "coalesce", "nullif", "lower", "upper", "length", "trim",
  "now", "clock_timestamp", "gen_random_uuid", "jsonb_build_object", "to_jsonb", "date_trunc"]);
const expressionFields: Record<string, string> = {
  A_Expr: "kind name lexpr rexpr", BoolExpr: "boolop args", NullTest: "arg nulltesttype argisrow",
  BooleanTest: "arg booltesttype", CaseExpr: "arg args defresult", CaseWhen: "expr result", CoalesceExpr: "args",
  ColumnRef: "fields", A_Star: "", String: "sval", List: "items", FuncCall: "funcname args agg_star agg_distinct funcformat",
  SQLValueFunction: "op typmod", TypeCast: "arg typeName",
};
function isAstNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasOnlyAstFields(value: Record<string, unknown>, allowed: string) {
  return Object.keys(value).every((key) => key === "location" || allowed.split(" ").includes(key));
}
function identifierParts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part: unknown) => isAstNode(part) && isAstNode(part.String) && typeof part.String.sval === "string" ? [part.String.sval] : []);
}
function catalogName(value: unknown) {
  const parts = identifierParts(value);
  return parts.length === 1 ? parts[0] : parts.length === 2 && parts[0] === "pg_catalog" ? parts[1] : undefined;
}
function typeName(value: unknown) {
  return isAstNode(value) && hasOnlyAstFields(value, "names typemod") && types.has(catalogName(value.names) ?? "");
}
function constant(value: unknown): boolean {
  return isAstNode(value) && (isAstNode(value.A_Const) || (isAstNode(value.TypeCast)
    && hasOnlyAstFields(value.TypeCast, "arg typeName") && typeName(value.TypeCast.typeName) && constant(value.TypeCast.arg)));
}
function expression(value: unknown, depth = 0): boolean {
  if (depth > 128) return false;
  if (Array.isArray(value)) return value.every((child) => expression(child, depth + 1));
  if (!isAstNode(value)) return true;
  return Object.entries(value).every(([kind, node]) => {
    if (!isAstNode(node)) return false;
    if (kind === "A_Const") return true;
    const allowed = expressionFields[kind];
    if (allowed === undefined || !hasOnlyAstFields(node, allowed)) return false;
    if (kind === "TypeCast") return typeName(node.typeName) && expression(node.arg, depth + 1);
    if (kind === "A_Expr" && (!["AEXPR_OP", "AEXPR_NULLIF"].includes(String(node.kind))
      || identifierParts(node.name).length !== 1 || !operators.has(identifierParts(node.name)[0] ?? ""))) return false;
    if (kind === "FuncCall") {
      const name = catalogName(node.funcname) ?? "";
      if (!functions.has(name) && !(node.funcformat === "COERCE_SQL_SYNTAX" && ["btrim", "ltrim", "rtrim"].includes(name))) return false;
      if ((node.agg_star || node.agg_distinct) && !["count", "sum", "min", "max", "avg", "jsonb_agg"].includes(name)) return false;
    }
    if (kind === "SQLValueFunction" && node.op !== "SVFOP_CURRENT_TIMESTAMP") return false;
    return Object.entries(node).every(([key, child]) => key === "location" || expression(child, depth + 1));
  });
}
function reserved(name: unknown) { return name === "principal_id" || name === "run_id"; }

function validateCheckExpression(value: unknown): boolean {
  const safeNodes = (value: unknown, depth = 0): boolean => {
    if (depth > 128) return false;
    if (Array.isArray(value)) return value.every((child) => safeNodes(child, depth + 1));
    if (!isAstNode(value)) return true;
    if ("FuncCall" in value || "SQLValueFunction" in value) return false;
    if (isAstNode(value.ColumnRef) && reserved(identifierParts(value.ColumnRef.fields).at(-1))) return false;
    return Object.values(value).every((child) => safeNodes(child, depth + 1));
  };
  return expression(value) && safeNodes(value);
}

export async function migrationPolicy(sql: string, schema: string): Promise<MigrationDecision> {
  let parsed;
  try { parsed = await parse(sql); }
  catch (error) {
    // Scanner boundaries preserve quoted semicolons when locating a syntax failure.
    const position = isAstNode(error) && isAstNode(error.sqlDetails) && typeof error.sqlDetails.cursorPosition === "number"
      ? error.sqlDetails.cursorPosition : 0;
    let statementIndex = 0;
    if (position > 0) {
      try {
        const tokens = (await scan(sql)).tokens;
        const bytePosition = Buffer.byteLength(Array.from(sql).slice(0, position).join(""));
        statementIndex = tokens.filter((token) => token.text === ";" && token.end <= bytePosition).length;
      } catch { /* Lexically invalid input has no reliable statement boundary. */ }
    }
    return { ok: false, reason: "migration_syntax_error", statementIndex };
  }
  const raws = parsed.stmts ?? [];
  if (raws.length > 100) return { ok: false, reason: "migration_too_many_statements", statementIndex: 100 };
  if (raws.length === 0) return { ok: false, reason: "migration_syntax_error", statementIndex: 0 };
  const statements: MigrationStatement[] = [];
  const tables = new Set<string>();
  const bytes = Buffer.from(sql);
  for (const [statementIndex, raw] of raws.entries()) {
    let reservedColumn = false;
    const targets: string[] = [];
    const checkColumn = (name: unknown) => { if (reserved(name)) reservedColumn = true; return typeof name === "string"; };
    const validateWorkspaceRelation = (value: unknown) => {
      if (!isAstNode(value) || !hasOnlyAstFields(value, "schemaname relname inh relpersistence") || typeof value.relname !== "string"
        || value.relname.startsWith("pg_") || (value.schemaname !== undefined && value.schemaname !== schema)
        || value.relpersistence !== "p") return false;
      targets.push(value.relname); tables.add(value.relname); return true;
    };
    const validateObjectPath = (value: unknown, suffix: boolean, isTable: boolean) => {
      if (!isAstNode(value) || !isAstNode(value.List)) return false;
      const parts = identifierParts(value.List.items);
      if (suffix) { const column = parts.pop(); if (reserved(column)) reservedColumn = true; }
      if (parts.length < 1 || parts.length > 2 || (parts.length === 2 && parts[0] !== schema)) return false;
      const name = parts.at(-1);
      if (!name || name.startsWith("pg_")) return false;
      targets.push(name); if (isTable) tables.add(name); return true;
    };
    const constraint = (value: unknown): boolean => {
      if (!isAstNode(value) || !isAstNode(value.Constraint)) return false;
      const c = value.Constraint;
      if (!hasOnlyAstFields(c, "contype conname is_enforced initially_valid raw_expr keys pktable fk_attrs pk_attrs fk_matchtype fk_upd_action fk_del_action")) return false;
      if (c.is_enforced === false || c.initially_valid === false) return false;
      if ([...identifierParts(c.keys), ...identifierParts(c.fk_attrs), ...identifierParts(c.pk_attrs)].some(reserved)) reservedColumn = true;
      switch (c.contype) {
        case "CONSTR_NULL": case "CONSTR_NOTNULL": return true;
        case "CONSTR_DEFAULT": return constant(c.raw_expr);
        case "CONSTR_CHECK": return validateCheckExpression(c.raw_expr);
        case "CONSTR_UNIQUE": case "CONSTR_PRIMARY": return true;
        case "CONSTR_FOREIGN": return validateWorkspaceRelation(c.pktable) && ["a", "r"].includes(String(c.fk_upd_action))
          && ["a", "r"].includes(String(c.fk_del_action)) && c.fk_matchtype === "s";
        default: return false;
      }
    };
    const column = (value: unknown, alteringType = false) => {
      if (!isAstNode(value) || !isAstNode(value.ColumnDef)) return false;
      const c = value.ColumnDef;
      return hasOnlyAstFields(c, "colname typeName is_local constraints") && (alteringType || checkColumn(c.colname))
        && typeName(c.typeName) && (c.constraints === undefined || Array.isArray(c.constraints) && c.constraints.every(constraint));
    };
    const root: unknown = raw.stmt;
    const kind = isAstNode(root) ? Object.keys(root)[0] ?? "" : "";
    const node = isAstNode(root) ? root[kind] : null;
    let valid = false;
    let destructive = false;
    if (isAstNode(node)) switch (kind) {
      case "CreateStmt":
        valid = hasOnlyAstFields(node, "relation tableElts oncommit if_not_exists") && validateWorkspaceRelation(node.relation)
          && node.oncommit === "ONCOMMIT_NOOP" && (node.tableElts === undefined || Array.isArray(node.tableElts)
            && node.tableElts.every((elt) => isAstNode(elt) && ("ColumnDef" in elt ? column(elt) : constraint(elt))));
        break;
      case "AlterTableStmt":
        valid = hasOnlyAstFields(node, "relation cmds objtype missing_ok") && validateWorkspaceRelation(node.relation) && node.objtype === "OBJECT_TABLE"
          && Array.isArray(node.cmds) && node.cmds.every((wrapped) => {
            if (!isAstNode(wrapped) || !isAstNode(wrapped.AlterTableCmd)) return false;
            const c = wrapped.AlterTableCmd;
            if (!hasOnlyAstFields(c, "subtype name def behavior missing_ok") || c.behavior !== "DROP_RESTRICT") return false;
            if (c.subtype !== "AT_AddConstraint" && c.subtype !== "AT_DropConstraint" && reserved(c.name)) reservedColumn = true;
            switch (c.subtype) {
              case "AT_AddColumn": return column(c.def);
              case "AT_ColumnDefault": return c.def === undefined || constant(c.def);
              case "AT_SetNotNull": case "AT_DropNotNull": return true;
              case "AT_AlterColumnType": destructive = true; return column(c.def, true);
              case "AT_AddConstraint": return constraint(c.def);
              case "AT_DropConstraint": case "AT_DropColumn": destructive = true; return true;
              default: return false;
            }
          });
        break;
      case "IndexStmt":
        valid = hasOnlyAstFields(node, "idxname relation accessMethod indexParams whereClause unique if_not_exists")
          && node.accessMethod === "btree" && validateWorkspaceRelation(node.relation) && Array.isArray(node.indexParams)
          && node.indexParams.every((elt) => isAstNode(elt) && isAstNode(elt.IndexElem)
            && hasOnlyAstFields(elt.IndexElem, "name ordering nulls_ordering") && typeof elt.IndexElem.name === "string")
          && expression(node.whereClause);
        break;
      case "DropStmt":
        destructive = true;
        valid = hasOnlyAstFields(node, "objects removeType behavior missing_ok") && node.behavior === "DROP_RESTRICT"
          && ["OBJECT_TABLE", "OBJECT_INDEX"].includes(String(node.removeType))
          && Array.isArray(node.objects) && node.objects.every((target) => validateObjectPath(target, false, node.removeType === "OBJECT_TABLE"));
        break;
      case "CommentStmt":
        valid = hasOnlyAstFields(node, "objtype object comment") && ["OBJECT_TABLE", "OBJECT_INDEX", "OBJECT_COLUMN", "OBJECT_TABCONSTRAINT"].includes(String(node.objtype))
          && validateObjectPath(node.object, node.objtype === "OBJECT_COLUMN" || node.objtype === "OBJECT_TABCONSTRAINT", node.objtype !== "OBJECT_INDEX");
        break;
      case "InsertStmt": case "UpdateStmt": case "DeleteStmt": {
        const start = raw.stmt_location ?? 0;
        const text = bytes.subarray(start, raw.stmt_len ? start + raw.stmt_len : undefined).toString();
        const decision = await statementPolicy(text, schema, 0);
        const writesReserved = (value: unknown) => Array.isArray(value) && value.some((target) =>
          isAstNode(target) && isAstNode(target.ResTarget) && reserved(target.ResTarget.name));
        reservedColumn = writesReserved(node.cols) || (kind === "UpdateStmt" && writesReserved(node.targetList))
          || (isAstNode(node.onConflictClause) && writesReserved(node.onConflictClause.targetList));
        valid = decision.ok && node.returningClause === undefined
          && (kind !== "InsertStmt" || node.selectStmt === undefined || Array.isArray(node.cols) && node.cols.length > 0);
        if (decision.ok) decision.relations.forEach((name) => tables.add(name));
        if (isAstNode(node.relation) && typeof node.relation.relname === "string") targets.push(node.relation.relname);
        destructive = kind !== "InsertStmt" || isAstNode(node.onConflictClause) && node.onConflictClause.action === "ONCONFLICT_UPDATE";
        break;
      }
    }
    if (reservedColumn) return { ok: false, reason: "migration_reserved_column", statementIndex };
    if (!valid) return { ok: false, reason: "migration_statement_forbidden", statementIndex };
    statements.push({ kind, target: kind === "DropStmt" ? targets.join(",") : targets[0] ?? "", destructive });
  }
  return { ok: true, statements, destructive: statements.some((statement) => statement.destructive), tables: [...tables].sort() };
}
