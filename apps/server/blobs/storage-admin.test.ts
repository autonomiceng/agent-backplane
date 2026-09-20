import { expect, test } from "bun:test";
import { storageAdminError, storageAdminOptions } from "./storage-admin.ts";
test("operator CLI requires an explicit verb and retains checkpoint/fence evidence", () => {
  expect(storageAdminOptions(["initialize"])).toEqual({ mode: "initialize", fenced: false, checkpoint: "", retain: false });
  expect(storageAdminOptions(["reconcile", "--fenced", "--checkpoint", "capture-1", "--retain-unreferenced"]))
    .toEqual({ mode: "reconcile", fenced: true, checkpoint: "capture-1", retain: true });
  expect(() => storageAdminOptions([])).toThrow();
  expect(() => storageAdminOptions(["initialize", "--retain-unreferenced"])).toThrow();
  expect(storageAdminError(new Error("postgres://private-secret"))).toBe("blob_binding_operator_failed");
  expect(storageAdminError(new Error("blob_binding_busy"))).toBe("blob_binding_busy");
});
