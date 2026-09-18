import { expect, test } from "bun:test";
import { decisionPolicy } from "./decision-policy.ts";

test("approval policy permits self-approval, an expired or stale target, or a second decision", () => {
  const facts = {
    decided: false, expired: false, current: true, state: "held",
    targetVersion: "held-version", heldVersion: "held-version", allowSelfApproval: false,
    principalId: "approver", requestedBy: "requester", requestedRunPrincipalId: "requesting-run-owner",
  };
  expect(decisionPolicy(facts)).toBeNull();
  expect(decisionPolicy({ ...facts, principalId: facts.requestedBy })).toBe("approval_self_forbidden");
  expect(decisionPolicy({ ...facts, principalId: facts.requestedRunPrincipalId })).toBe("approval_self_forbidden");
  expect(decisionPolicy({ ...facts, principalId: facts.requestedBy, allowSelfApproval: true })).toBeNull();

  // The adapter supplies the database's expires_at <= clock_timestamp() comparison.
  const expiresAt = Date.parse("2026-09-14T12:00:00Z");
  const databaseNow = expiresAt;
  expect(decisionPolicy({ ...facts, expired: expiresAt <= databaseNow })).toBe("approval_expired");
  expect(decisionPolicy({ ...facts, heldVersion: "successor-version" })).toBe("approval_stale");
  expect(decisionPolicy({ ...facts, decided: true })).toBe("approval_decided");
});
