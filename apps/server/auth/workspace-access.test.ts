import { expect, test } from "bun:test";
import { workspaceAccess } from "./workspace-access.ts";

test("principal identity bypasses Workspace membership if absent, revoked or unknown facts are accepted", () => {
  const memberships = [{ organizationId: "default", revoked: false }];
  expect(workspaceAccess({ organizationId: "default", memberships })).toEqual({ allowed: true });
  expect(workspaceAccess({ organizationId: "other", memberships })).toEqual({ allowed: false, reason: "workspace_forbidden" });
  expect(workspaceAccess({ organizationId: "default", memberships: [{ organizationId: "default", revoked: true }] }))
    .toEqual({ allowed: false, reason: "workspace_forbidden" });
  expect(workspaceAccess({ organizationId: null, memberships })).toEqual({ allowed: false, reason: "workspace_forbidden" });
});
