// Row-target adapters validate the single-row proposal after the general SQL allowlist.
import { parse } from "libpg-query";

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

export async function gatedProposal(statement: string, params: unknown[], table: string, pk: string[], temporal: string[] = []): Promise<Record<string, unknown> | null> {
  const root = (await parse(statement)).stmts?.[0]?.stmt;
  if (!object(root)) return null;
  const mutation = ("UpdateStmt" in root ? root.UpdateStmt : "DeleteStmt" in root ? root.DeleteStmt : undefined);
  if (!object(mutation) || !object(mutation.relation) || mutation.relation.relname !== table
    || mutation.fromClause || mutation.usingClause || mutation.withClause) return null;
  const alias = object(mutation.relation.alias) ? mutation.relation.alias.aliasname : table;
  const column = (value: unknown) => {
    if (!object(value) || !object(value.ColumnRef)) return undefined;
    const parts = Array.isArray(value.ColumnRef.fields) ? value.ColumnRef.fields.map((part: unknown) =>
      object(part) && "A_Star" in part ? "*" : object(part) && object(part.String) ? part.String.sval : null) : [];
    return parts.length === 1 ? parts[0] : parts.length === 2 && parts[0] === alias ? parts[1] : undefined;
  };
  const deterministic = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(deterministic);
    if (!object(value)) return true;
    if (["SelectStmt", "SubLink", "RangeSubselect", "WithClause", "SQLValueFunction", "SetToDefault"].some((key) => key in value)) return false;
    if (object(value.TypeCast) && (!object(value.TypeCast.typeName)
      || !["text", "int4", "int8", "numeric", "bool", "uuid", "jsonb"].includes(catalogName(value.TypeCast.typeName.names)))) return false;
    if (object(value.FuncCall) && !["lower", "upper", "length", "trim", "btrim", "ltrim", "rtrim", "jsonb_build_object", "to_jsonb"].includes(catalogName(value.FuncCall.funcname))) return false;
    if (object(value.ColumnRef) && column(value) === undefined) return false;
    return Object.values(value).every(deterministic);
  };
  if (!deterministic(mutation)) return null;
  const temporalValue = (value: unknown) => {
    const name = column(value);
    if (typeof name === "string" && temporal.includes(name)) return true;
    if (!object(value)) return false;
    const literal = object(value.ParamRef) && typeof value.ParamRef.number === "number" ? params[value.ParamRef.number - 1]
      : object(value.A_Const) && value.A_Const.isnull ? null
        : object(value.A_Const) && object(value.A_Const.sval) ? value.A_Const.sval.sval : undefined;
    return literal === null || typeof literal === "string" && /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/.test(literal);
  };
  if (Array.isArray(mutation.targetList) && mutation.targetList.some((target) => object(target) && object(target.ResTarget)
    && temporal.includes(String(target.ResTarget.name)) && !temporalValue(target.ResTarget.val))) return null;
  if (Array.isArray(mutation.targetList) && mutation.targetList.some((target) =>
    object(target) && object(target.ResTarget) && pk.includes(String(target.ResTarget.name)))) return null;
  const key = new Map<string, unknown>();
  const equality = (value: unknown): boolean => {
    if (!object(value)) return false;
    if (object(value.BoolExpr)) return value.BoolExpr.boolop === "AND_EXPR" && Array.isArray(value.BoolExpr.args) && value.BoolExpr.args.every(equality);
    const expr = value.A_Expr;
    if (!object(expr) || expr.kind !== "AEXPR_OP" || names(expr.name).join() !== "=") return false;
    const left = column(expr.lexpr), right = column(expr.rexpr);
    const name = left ?? right, bound = left === undefined ? expr.lexpr : expr.rexpr;
    if (typeof name !== "string" || !pk.includes(name) || key.has(name) || !object(bound)) return false;
    if (object(bound.ParamRef) && typeof bound.ParamRef.number === "number") key.set(name, params[bound.ParamRef.number - 1]);
    else if (object(bound.A_Const)) {
      const c = bound.A_Const;
      key.set(name, object(c.ival) ? c.ival.ival ?? 0 : object(c.fval) ? c.fval.fval
        : object(c.sval) ? c.sval.sval ?? "" : object(c.boolval) ? c.boolval.boolval ?? false : null);
    } else return false;
    return key.get(name) !== null && key.get(name) !== undefined;
  };
  return equality(mutation.whereClause) && key.size === pk.length ? Object.fromEntries(key) : null;
}
