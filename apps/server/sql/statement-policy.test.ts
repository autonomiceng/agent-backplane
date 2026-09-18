import { expect, test } from "bun:test";
import { statementPolicy } from "./statement-policy.ts";

test("statement escape admits stacked commands, nested settings or protected relations and fingerprints retain literals", async () => {
  const schema = "ws_0123456789abcdef0123456789abcdef";
  expect(await statementPolicy("SELECT 1; SELECT 2", schema, 0)).toEqual({ ok: false, reason: "sql_multiple_statements" });
  expect(await statementPolicy("SELECT 1; /* hidden */ RESET ROLE", schema, 0)).toEqual({ ok: false, reason: "sql_multiple_statements" });
  expect(await statementPolicy("SELECT FROM", schema, 0)).toEqual({ ok: false, reason: "sql_syntax_error" });
  const forbidden = [
    "SET ROLE bp_server", "RESET ROLE", "SELECT set_config('role', 'bp_server', true)",
    "SELECT (SELECT set_config('role', 'bp_server', true))",
    "WITH c AS (SELECT set_config('role', 'bp_server', true)) SELECT * FROM c",
    "WITH hidden AS (UPDATE details SET note='x' RETURNING *) DELETE FROM items WHERE false",
    "COPY items TO STDOUT", "DO $$ BEGIN END $$", "SELECT pg_sleep(3)",
    "SELECT * FROM pg_catalog.pg_roles", "SELECT * FROM other.items",
    "SELECT * FROM pg_roles", "SELECT * INTO stolen FROM items", "SELECT * FROM items FOR UPDATE",
    "SELECT * FROM items UNION SELECT * FROM items", "SELECT count(*) OVER () FROM items",
    "SELECT * FROM LATERAL (SELECT 1) s", "SELECT * FROM generate_series(1, 2)",
    "SELECT 'x' COLLATE \"C\"", "SELECT 1 OPERATOR(other.+) 2", "SELECT CURRENT_USER",
    "WITH RECURSIVE c AS (SELECT 1) SELECT * FROM c", "SELECT $2", "SELECT $1",
  ];
  for (const sql of forbidden) {
    expect(await statementPolicy(sql, schema, 0)).toMatchObject({ ok: false, reason: "sql_statement_forbidden" });
  }
  const complex = `WITH c AS (SELECT id FROM items WHERE id > 123)
    SELECT c.id, count(*) FROM c LEFT JOIN (SELECT id FROM details) d ON c.id = d.id
    WHERE EXISTS (SELECT 1 FROM details WHERE id = c.id)
    GROUP BY c.id HAVING count(*) > 1 ORDER BY c.id LIMIT $1 OFFSET 0`;
  const decision = await statementPolicy(complex, schema, 1);
  expect(decision).toMatchObject({ ok: true, kind: "select", relations: ["details", "items"] });
  expect(await statementPolicy(complex.replace("123", "987654321"), schema, 1)).toEqual(decision);
  if (!decision.ok) throw new Error("expected accepted SELECT");
  expect(decision.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(await statementPolicy(`INSERT INTO ${schema}.items (id) VALUES ($1)
    ON CONFLICT ON CONSTRAINT items_pkey DO UPDATE SET id = excluded.id RETURNING *`, schema, 1))
    .toMatchObject({ ok: true, kind: "insert", relations: ["items"] });
  expect(await statementPolicy("UPDATE items SET id = $1 WHERE id = $2 RETURNING id", schema, 2))
    .toMatchObject({ ok: true, kind: "update", relations: ["items"] });
  expect(await statementPolicy("WITH items AS (SELECT id FROM details) UPDATE items SET id = $1", schema, 1))
    .toMatchObject({ ok: true, kind: "update", relations: ["details", "items"] });
  expect(await statementPolicy("SELECT trim(' x '), coalesce(NULL, 'a'), nullif(1, 2), CURRENT_TIMESTAMP, $1::uuid", schema, 1))
    .toMatchObject({ ok: true, kind: "select", relations: [] });
  expect(await statementPolicy("SELECT $1", schema, 2)).toMatchObject({ ok: false, reason: "sql_statement_forbidden", node: "ParamRef" });
});
