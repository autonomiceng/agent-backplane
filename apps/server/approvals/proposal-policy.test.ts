import { expect, test } from "bun:test";
import { gatedProposal } from "./proposal-policy.ts";

// Budget overage: one millisecond-scale pure case accompanies the extracted proposal concept.
test("proposal validation loses exact PK values or accepts partial keys, PK changes and nondeterministic writes", async () => {
  expect(await gatedProposal("UPDATE items AS i SET updates = updates + 1 WHERE i.id = $1 AND part = 1.00 RETURNING i.*",
    ["9007199254740993"], "items", ["id", "part"]))
    .toEqual({ id: "9007199254740993", part: "1.00" });
  expect(await gatedProposal("DELETE FROM items WHERE id = 9007199254740993", [], "items", ["id"]))
    .toEqual({ id: "9007199254740993" });
  expect(await gatedProposal("UPDATE items SET updates = 1 WHERE id = $1", [1], "items", ["id", "part"])).toBeNull();
  expect(await gatedProposal("UPDATE items SET id = 2 WHERE id = $1", [1], "items", ["id"])).toBeNull();
  expect(await gatedProposal("UPDATE items SET updates = 1 WHERE id = $1 OR id = $2", [1, 2], "items", ["id"])).toBeNull();
  expect(await gatedProposal("UPDATE items SET updates = other.updates FROM other WHERE items.id = $1", [1], "items", ["id"])).toBeNull();
  expect(await gatedProposal("UPDATE items SET at = now() WHERE id = $1", [1], "items", ["id"], ["at"])).toBeNull();
  expect(await gatedProposal("UPDATE items SET at = CURRENT_TIMESTAMP WHERE id = $1", [1], "items", ["id"], ["at"])).toBeNull();
  expect(await gatedProposal("UPDATE items SET at = $1 WHERE id = $2", ["now", 1], "items", ["id"], ["at"])).toBeNull();
  expect(await gatedProposal("UPDATE items SET at = $1 WHERE id = $2", ["2026-01-01T00:00:00Z", 1], "items", ["id"], ["at"]))
    .toEqual({ id: 1 });
});
