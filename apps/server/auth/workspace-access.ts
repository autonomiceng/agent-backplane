// The membership decision, pure. The query adapter supplies the Workspace and current membership facts.
export type WorkspaceAccessFacts = {
  organizationId: string | null;
  memberships: { organizationId: string; revoked: boolean }[];
};

export function workspaceAccess(facts: WorkspaceAccessFacts): { allowed: true } | { allowed: false; reason: "workspace_forbidden" } {
  return facts.organizationId !== null && facts.memberships.some((m) => m.organizationId === facts.organizationId && !m.revoked)
    ? { allowed: true }
    : { allowed: false, reason: "workspace_forbidden" };
}
