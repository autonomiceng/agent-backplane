import { expect, test } from "bun:test";
import { relationContract, type RelationFacts } from "./relation-contract.ts";

// Sixth case: pure catalog decision runs without Postgres.
test("relation contract admits missing or foreign objects, unstamped rows or executable table attachments", () => {
  const table: RelationFacts = {
    schema: "ws_test", name: "items", kind: "r", owner: "bp_executor",
    principalUuid: true, principalNotNull: true, runUuid: true, runNotNull: true,
    generated: false, triggerCount: 1, stampEnabled: "A", stampFunction: true, rules: false, policies: false,
  };
  const decide = (facts: RelationFacts[]) => relationContract("ws_test", ["items"], facts);
  const denied = { ok: false, reason: "sql_relation_contract" } as const;
  expect(decide([table])).toEqual({ ok: true });
  expect(decide([])).toEqual(denied);
  expect(decide([{ ...table, schema: "ws_other" }])).toEqual(denied);
  expect(relationContract("ws_test", ["items", "missing"], [table])).toEqual(denied);
  expect(decide([{ ...table, kind: "v" }])).toEqual(denied);
  expect(decide([{ ...table, kind: "f" }])).toEqual(denied);
  expect(decide([{ ...table, owner: "bp_server" }])).toEqual(denied);
  expect(decide([{ ...table, principalUuid: null, principalNotNull: null }])).toEqual(denied);
  expect(decide([{ ...table, principalUuid: false }])).toEqual(denied);
  expect(decide([{ ...table, principalNotNull: false }])).toEqual(denied);
  expect(decide([{ ...table, runUuid: false }])).toEqual(denied);
  expect(decide([{ ...table, runNotNull: false }])).toEqual(denied);
  expect(decide([{ ...table, generated: true }])).toEqual(denied);
  expect(decide([{ ...table, triggerCount: 0, stampEnabled: null, stampFunction: null }])).toEqual(denied);
  expect(decide([{ ...table, triggerCount: 2 }])).toEqual(denied);
  expect(decide([{ ...table, stampEnabled: "O" }])).toEqual(denied);
  expect(decide([{ ...table, stampFunction: false }])).toEqual(denied);
  expect(decide([{ ...table, rules: true }])).toEqual(denied);
  expect(decide([{ ...table, policies: true }])).toEqual(denied);
});
