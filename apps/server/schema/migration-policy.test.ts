import { expect, test } from "bun:test";
import { migrationPolicy } from "./migration-policy.ts";

test("forbidden DDL escapes the Migration allowlist or reserved-column guard", async () => {
  const schema = "ws_0123456789abcdef0123456789abcdef";
  for (const sql of ["CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
    "CREATE TRIGGER evil BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f()", "CREATE VIEW v AS SELECT 1",
    "CREATE TABLE other_schema.t (id int)", "CREATE TABLE t (id serial)", "DROP TABLE t CASCADE", "SET ROLE bp_server", "RESET ROLE",
    "INSERT INTO t VALUES (1)", "INSERT INTO t SELECT 1",
    "CREATE TABLE checked (id int CHECK (length('x') > 0))",
    "ALTER TABLE t ADD CONSTRAINT check_time CHECK (CURRENT_TIMESTAMP IS NOT NULL)",
    "ALTER TABLE t ADD CONSTRAINT check_run CHECK (t.run_id IS NOT NULL)"]) {
    expect(await migrationPolicy(`CREATE TABLE t (id int); ${sql}`, schema))
      .toEqual({ ok: false, reason: "migration_statement_forbidden", statementIndex: 1 });
  }
  expect(await migrationPolicy("INSERT INTO t (id, run_id) VALUES (1, NULL)", schema))
    .toEqual({ ok: false, reason: "migration_reserved_column", statementIndex: 0 });
  expect(await migrationPolicy("INSERT INTO t DEFAULT VALUES", schema)).toMatchObject({ ok: true, destructive: false });
  expect(await migrationPolicy("INSERT INTO t (id) VALUES (1) ON CONFLICT ON CONSTRAINT t_pkey DO UPDATE SET id = 2", schema))
    .toEqual({ ok: true, destructive: true, tables: ["t"], statements: [{ kind: "InsertStmt", target: "t", destructive: true }] });
  expect(await migrationPolicy("COMMENT ON INDEX t_id IS 'private'; DROP INDEX t_id", schema))
    .toMatchObject({ ok: true, tables: [] });
  expect(await migrationPolicy("CREATE TABLE t (id int); ALTER TABLE t ALTER COLUMN run_id DROP NOT NULL", schema))
    .toEqual({ ok: false, reason: "migration_reserved_column", statementIndex: 1 });
  expect(await migrationPolicy("CREATE TABLE t (id int); SELECT FROM", schema))
    .toEqual({ ok: false, reason: "migration_syntax_error", statementIndex: 1 });
  expect(await migrationPolicy("COMMENT ON TABLE t IS 'x';".repeat(101), schema))
    .toEqual({ ok: false, reason: "migration_too_many_statements", statementIndex: 100 });
  expect(await migrationPolicy(`CREATE TABLE t (id int PRIMARY KEY CHECK (id > 0), note text DEFAULT 'é;', payload bytea) ;
    ALTER TABLE t ADD COLUMN extra text; CREATE INDEX t_id ON t (id) WHERE id > 0;
    COMMENT ON TABLE t IS 'private'; INSERT INTO t (id, note) VALUES (1, 'é;')`, schema)).toEqual({
    ok: true, destructive: false, tables: ["t"], statements: [
      { kind: "CreateStmt", target: "t", destructive: false }, { kind: "AlterTableStmt", target: "t", destructive: false },
      { kind: "IndexStmt", target: "t", destructive: false }, { kind: "CommentStmt", target: "t", destructive: false },
      { kind: "InsertStmt", target: "t", destructive: false },
    ],
  });
});
