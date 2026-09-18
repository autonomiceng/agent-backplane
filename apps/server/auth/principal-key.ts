// Principal authentication decisions from parsed credentials and database facts, used by principal-session.
export type PrincipalIdentity = { principalId: string; workspaceId: string };
export type PrincipalKeyFacts = PrincipalIdentity & { status: string; revokedAt: Date | null };

export function parsePrincipalKey(bearer: string | null): { prefix: string; secret: string } | null {
  const match = /^Bearer bp_([0-9a-f]{24})_([0-9a-f]{64})$/.exec(bearer ?? "");
  return match && match[0] === bearer ? { prefix: match[1]!, secret: match[2]! } : null;
}

export function decidePrincipalKey(facts: PrincipalKeyFacts | null, secretMatches: boolean):
  | { status: "authenticated"; principal: PrincipalIdentity }
  | { status: "unknown" | "revoked" | "mismatch" } {
  if (!facts) return { status: "unknown" };
  if (!secretMatches) return { status: "mismatch" };
  if (facts.status !== "active" || facts.revokedAt !== null) return { status: "revoked" };
  return { status: "authenticated", principal: { principalId: facts.principalId, workspaceId: facts.workspaceId } };
}
