import { expect, test } from "bun:test";
import { migrationConsumptionPolicy, migrationRequestPolicy, type MigrationApproval } from "./approval-migration-policy.ts";

// Budget overage: one millisecond-scale pure case is required by the decide-then-act rule.
test("Migration Approval failure precedence hides revision, epoch, expiry, consumption or receipt substitution", () => {
  const gate = { epoch: "current", targetVersion: "1" };
  const input = { expectedRevision: 1, sqlHash: "hash", previewPosition: "10" };
  const approval: MigrationApproval = { target_kind: "migration", target_id: "hash", target_version: "1", requested_by: "principal",
    gate_epoch: "current", action_hash: "hash", decision: "approve", consumed: false, expired: false, decision_position: "11", preview_position: "10" };
  expect(migrationRequestPolicy({ ...gate, previewMatches: true }, 1)).toBeNull();
  expect(migrationRequestPolicy({ ...gate, epoch: null, previewMatches: false }, 0)).toBe("approval_gate_not_found");
  expect(migrationRequestPolicy({ ...gate, previewMatches: false }, 0)).toBe("approval_stale");
  expect(migrationRequestPolicy({ ...gate, previewMatches: false }, 1)).toBe("approval_mismatch");
  expect(migrationConsumptionPolicy(gate, input, "principal", approval)).toBeNull();
  expect(migrationConsumptionPolicy({ ...gate, targetVersion: "2", epoch: "rotated" }, input, "principal", approval)).toBe("revision_stale");
  expect(migrationConsumptionPolicy({ ...gate, targetVersion: "2" }, { ...input, expectedRevision: 2 }, "principal", approval)).toBe("approval_stale");
  expect(migrationConsumptionPolicy({ ...gate, epoch: "rotated" }, input, "principal", approval)).toBe("approval_stale");
  expect(migrationConsumptionPolicy({ ...gate, epoch: null }, input, "principal", approval)).toBe("approval_stale");
  expect(migrationConsumptionPolicy(gate, input, "principal", { ...approval, expired: true, gate_epoch: "old" })).toBe("approval_expired");
  expect(migrationConsumptionPolicy(gate, input, "principal", { ...approval, consumed: true, expired: true })).toBe("approval_consumed");
  expect(migrationConsumptionPolicy(gate, { ...input, sqlHash: "different" }, "principal", { ...approval, consumed: true })).toBe("approval_mismatch");
  expect(migrationConsumptionPolicy(gate, { ...input, previewPosition: "12" }, "principal", approval)).toBe("approval_mismatch");
  expect(migrationConsumptionPolicy(gate, { ...input, previewPosition: "010" }, "principal", approval)).toBeNull();
  expect(migrationConsumptionPolicy(gate, input, "principal", { ...approval, decision: null })).toBe("approval_not_approved");
  expect(migrationConsumptionPolicy(gate, input, "principal", undefined)).toBe("approval_not_found");
});
