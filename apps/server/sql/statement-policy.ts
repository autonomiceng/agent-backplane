// executeSql uses this closed PostgreSQL AST policy before borrowing a transaction.
import { createHash } from "node:crypto";
import { parse } from "libpg-query";

export type StatementDecision =
  | { ok: true; kind: "select" | "insert" | "update" | "delete"; relations: string[]; fingerprint: string; writeTable?: string; insertOnly?: boolean }
  | { ok: false; reason: "sql_statement_forbidden" | "sql_multiple_statements" | "sql_syntax_error"; node?: string };

const fields: Record<string, string> = {
  SelectStmt: "targetList fromClause whereClause groupClause havingClause sortClause limitOffset limitCount limitOption withClause valuesLists op",
  InsertStmt: "relation cols selectStmt onConflictClause returningClause withClause override",
  UpdateStmt: "relation targetList whereClause fromClause returningClause withClause",
  DeleteStmt: "relation usingClause whereClause returningClause withClause",
  RangeVar: "schemaname relname inh relpersistence alias",
  Alias: "aliasname colnames",
  ResTarget: "name val",
  ColumnRef: "fields",
  A_Star: "",
  ParamRef: "number",
  A_Const: "ival fval sval boolval bsval isnull",
  A_Expr: "kind name lexpr rexpr",
  BoolExpr: "boolop args",
  NullTest: "arg nulltesttype argisrow",
  BooleanTest: "arg booltesttype",
  CaseExpr: "arg args defresult",
  CaseWhen: "expr result",
  CoalesceExpr: "args",
  JoinExpr: "jointype isNatural larg rarg usingClause join_using_alias quals alias",
  RangeSubselect: "subquery alias",
  SortBy: "node sortby_dir sortby_nulls",
  TypeCast: "arg typeName",
  TypeName: "names typemod",
  SubLink: "subLinkType testexpr operName subselect",
  CommonTableExpr: "ctename aliascolnames ctematerialized ctequery",
  WithClause: "ctes",
  List: "items",
  String: "sval",
  Integer: "ival",
  Float: "fval",
  Boolean: "boolval",
  BitString: "bsval",
  SetToDefault: "",
  OnConflictClause: "action infer targetList whereClause",
  InferClause: "conname",
  ReturningList: "exprs",
  FuncCall: "funcname args agg_star agg_distinct funcformat",
  SQLValueFunction: "op typmod",
};
const implicit: Record<string, string> = {
  relation: "RangeVar", alias: "Alias", join_using_alias: "Alias", withClause: "WithClause",
  typeName: "TypeName", onConflictClause: "OnConflictClause", infer: "InferClause", returningClause: "ReturningList",
};
const operators = new Set("= <> < <= > >= + - * / % || -> ->> @> ?".split(" "));
const aggregates = new Set(["count", "sum", "min", "max", "avg", "jsonb_agg"]);
const functions = new Set([...aggregates, "coalesce", "nullif", "lower", "upper", "length", "trim", "now",
  "clock_timestamp", "gen_random_uuid", "jsonb_build_object", "to_jsonb", "date_trunc"]);
const types = new Set(["text", "int4", "int8", "numeric", "bool", "uuid", "bytea", "jsonb", "timestamptz", "date"]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function names(value: unknown) {
  return Array.isArray(value) ? value.map((part: unknown) => object(part) && object(part.String) ? part.String.sval : null) : [];
}
function catalogName(value: unknown) {
  const parts = names(value);
  const name = parts.length === 1 ? parts[0] : parts.length === 2 && parts[0] === "pg_catalog" ? parts[1] : null;
  return typeof name === "string" ? name : "";
}
function constantOrParam(value: unknown) {
  return value === undefined || (object(value) && ("A_Const" in value || "ParamRef" in value));
}

export async function statementPolicy(statement: string, workspaceSchema: string, parameterCount: number): Promise<StatementDecision> {
  let parsed;
  try { parsed = await parse(statement); }
  catch { return { ok: false, reason: "sql_syntax_error" }; }
  if (parsed.stmts?.length !== 1) return { ok: false, reason: "sql_multiple_statements" };
  const root = parsed.stmts[0]?.stmt;
  if (!object(root)) return { ok: false, reason: "sql_syntax_error" };
  const kind = "SelectStmt" in root ? "select" : "InsertStmt" in root ? "insert"
    : "UpdateStmt" in root ? "update" : "DeleteStmt" in root ? "delete" : null;
  if (kind === null) return { ok: false, reason: "sql_statement_forbidden", node: Object.keys(root)[0] ?? "RawStmt" };
  const relations = new Set<string>();
  const parameters = new Set<number>();
  let forbidden: string | undefined;
  const reject = (node: string) => { forbidden ??= node; };

  function walk(value: unknown, scope: Set<string>, depth: number, nodeType?: string): void {
    if (forbidden || value === undefined || value === null) return;
    if (depth > 128) { reject(nodeType ?? "List"); return; }
    if (Array.isArray(value)) { for (const child of value) walk(child, scope, depth + 1); return; }
    if (!object(value)) return;
    if (!nodeType) {
      for (const [type, child] of Object.entries(value)) walk(child, scope, depth + 1, type);
      return;
    }
    const allowed = fields[nodeType];
    if (allowed === undefined) { reject(nodeType); return; }
    for (const key of Object.keys(value)) {
      if (key !== "location" && !allowed.split(" ").includes(key)) {
        const child = value[key];
        reject(key === "lockingClause" ? "LockingClause" : key === "intoClause" ? "IntoClause"
          : key === "over" ? "WindowDef" : object(child) ? Object.keys(child)[0] ?? nodeType : nodeType);
        return;
      }
    }
    if (nodeType === "SelectStmt" && (value.op !== "SETOP_NONE"
      || !constantOrParam(value.limitCount) || !constantOrParam(value.limitOffset)
      || (value.limitOption !== "LIMIT_OPTION_DEFAULT" && value.limitOption !== "LIMIT_OPTION_COUNT"))) reject(nodeType);
    if (nodeType === "InsertStmt" && value.override !== "OVERRIDING_NOT_SET") reject(nodeType);
    if (nodeType === "RangeVar") {
      if (typeof value.relname !== "string" || value.relname.startsWith("pg_")
        || (value.schemaname !== undefined && value.schemaname !== workspaceSchema)
        || value.schemaname === "pg_catalog" || value.schemaname === "information_schema") reject(nodeType);
      else if (value.schemaname !== undefined || !scope.has(value.relname)) relations.add(value.relname);
    }
    if (nodeType === "ParamRef") {
      if (typeof value.number !== "number" || !Number.isInteger(value.number) || value.number < 1 || value.number > parameterCount) reject(nodeType);
      else parameters.add(value.number);
    }
    if (nodeType === "A_Expr") {
      const op = names(value.name);
      if (op.length !== 1 || typeof op[0] !== "string" || !operators.has(op[0])
        || (value.kind !== "AEXPR_OP" && value.kind !== "AEXPR_NULLIF")) reject(nodeType);
    }
    if (nodeType === "JoinExpr" && value.jointype !== "JOIN_INNER" && value.jointype !== "JOIN_LEFT") reject(nodeType);
    if (nodeType === "TypeName" && !types.has(catalogName(value.names))) reject(nodeType);
    if (nodeType === "SubLink" && value.operName !== undefined) {
      const op = names(value.operName);
      if (op.length !== 1 || typeof op[0] !== "string" || !operators.has(op[0])) reject(nodeType);
    }
    if (nodeType === "OnConflictClause" && (value.action !== "ONCONFLICT_NOTHING" && value.action !== "ONCONFLICT_UPDATE"
      || (value.action === "ONCONFLICT_UPDATE" && (!object(value.infer) || typeof value.infer.conname !== "string")))) reject(nodeType);
    if (nodeType === "FuncCall") {
      const name = catalogName(value.funcname);
      // PostgreSQL lowers SQL TRIM syntax to these catalog functions.
      const trim = value.funcformat === "COERCE_SQL_SYNTAX" && ["btrim", "ltrim", "rtrim"].includes(name);
      if ((!functions.has(name) && !trim) || ((value.agg_star || value.agg_distinct) && !aggregates.has(name))) reject(nodeType);
    }
    if (nodeType === "SQLValueFunction" && value.op !== "SVFOP_CURRENT_TIMESTAMP") reject(nodeType);
    if (nodeType === "CommonTableExpr" && (!object(value.ctequery) || !object(value.ctequery.SelectStmt))) reject(nodeType);
    if (nodeType === "A_Const") return;

    let local = scope;
    if (nodeType.endsWith("Stmt") && object(value.withClause)) {
      local = new Set(scope);
      walk(value.withClause, local, depth + 1, "WithClause");
      const ctes = value.withClause.ctes;
      if (Array.isArray(ctes)) for (const cte of ctes) {
        if (object(cte) && object(cte.CommonTableExpr) && typeof cte.CommonTableExpr.ctename === "string") local.add(cte.CommonTableExpr.ctename);
      }
    }
    if (nodeType === "WithClause" && Array.isArray(value.ctes)) {
      const preceding = new Set(scope);
      for (const cte of value.ctes) {
        walk(cte, preceding, depth + 1);
        if (object(cte) && object(cte.CommonTableExpr) && typeof cte.CommonTableExpr.ctename === "string") preceding.add(cte.CommonTableExpr.ctename);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "location" && !(key === "withClause" && nodeType.endsWith("Stmt"))) {
        walk(child, key === "relation" ? new Set() : local, depth + 1, implicit[key]);
      }
    }
  }
  walk(root, new Set(), 0);
  if (parameters.size !== parameterCount) reject("ParamRef");
  if (forbidden) return { ok: false, reason: "sql_statement_forbidden", node: forbidden };
  const normalized = JSON.stringify(root, (key, value: unknown) => {
    if (key === "location") return undefined;
    if (key === "A_Const" && object(value)) {
      return value.isnull ? "null" : "ival" in value ? "integer" : "fval" in value ? "numeric"
        : "sval" in value ? "string" : "boolval" in value ? "boolean" : "bitstring";
    }
    return value;
  });
  const mutation = ("UpdateStmt" in root ? root.UpdateStmt : "DeleteStmt" in root ? root.DeleteStmt : "InsertStmt" in root ? root.InsertStmt : undefined);
  const writeTable = object(mutation) && object(mutation.relation) && typeof mutation.relation.relname === "string" ? mutation.relation.relname : undefined;
  const insertOnly = "InsertStmt" in root && root.InsertStmt.onConflictClause?.action !== "ONCONFLICT_UPDATE";
  return { ok: true, kind, ...(kind === "insert" ? { insertOnly } : {}), relations: [...relations].sort(), ...(writeTable ? { writeTable } : {}), fingerprint: createHash("sha256").update(normalized).digest("hex") };
}
