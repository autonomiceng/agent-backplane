import { expect, test } from "bun:test";
import { storageAdminError, storageAdminOptions } from "./storage-admin.ts";
test("operator CLI requires an explicit verb and retains checkpoint/fence evidence", () => {
  expect(storageAdminOptions(["initialize"])).toEqual({ mode: "initialize", fenced: false, checkpoint: "", retain: false });
  expect(storageAdminOptions(["reconcile", "--fenced", "--checkpoint", "capture-1", "--retain-unreferenced"]))
    .toEqual({ mode: "reconcile", fenced: true, checkpoint: "capture-1", retain: true });
  expect(() => storageAdminOptions([])).toThrow();
  expect(() => storageAdminOptions(["adopt", "--fenced", "--checkpoint", "capture-1"])).toThrow("blob_binding_usage");
  expect(() => storageAdminOptions(["initialize", "--retain-unreferenced"])).toThrow();
  for (const option of [["--checkpoint", "capture"], ["--retain-unreferenced"], ["--checkpoint", ""]]) {
    expect(() => storageAdminOptions(["inspect", "--fenced", ...option])).toThrow("blob_binding_usage");
  }
  expect(storageAdminError(new Error("postgres://private-secret"))).toBe("blob_binding_operator_failed");
  expect(storageAdminError(new Error("backup_credential_file_must_be_private_and_owned"))).toBe("blob_binding_operator_credential_invalid");
  expect(storageAdminError(new Error("backup_credential_url_invalid"))).toBe("blob_binding_operator_credential_invalid");
  expect(storageAdminError(Object.assign(new Error("/private/store"), { code: "EACCES" }))).toBe("blob_binding_operator_eacces");
  expect(storageAdminError(new Error("blob_inventory_invalid"))).toBe("blob_binding_store_inventory_invalid");
  expect(storageAdminError(Object.assign(new Error("/private/store"), { code: "private-token" }))).toBe("blob_binding_operator_failed");
  expect(storageAdminError(new Error("blob_binding_busy"))).toBe("blob_binding_busy");
});
