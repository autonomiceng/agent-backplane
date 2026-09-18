// Validates the server's Workspace and actor stamp before adapters bind it to a transaction.

export type RunContext =
  | { workspaceId: string; principalId: string; runId: string; invocationHash?: Buffer }
  | { workspaceId: string; userId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRunContext(input: unknown): { ok: true; context: RunContext } | { ok: false; reason: "context_invalid" } {
  if (
    typeof input === "object" && input !== null && "workspaceId" in input
    && typeof input.workspaceId === "string" && UUID.test(input.workspaceId)
  ) {
    if (
      "principalId" in input && "runId" in input && !("userId" in input)
      && typeof input.principalId === "string" && UUID.test(input.principalId)
      && typeof input.runId === "string" && UUID.test(input.runId)
    ) {
      return { ok: true, context: { workspaceId: input.workspaceId, principalId: input.principalId, runId: input.runId } };
    }
    if (
      "userId" in input && !("principalId" in input) && !("runId" in input)
      && typeof input.userId === "string" && input.userId.length > 0
    ) {
      return { ok: true, context: { workspaceId: input.workspaceId, userId: input.userId } };
    }
  }
  return { ok: false, reason: "context_invalid" };
}
