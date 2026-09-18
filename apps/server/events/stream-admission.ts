// The stream route supplies current counts and limits; this decision owns no mutable state.
export function admitStream(counts: { app: number; workspace: number; actor: number },
  limits: { app: number; workspace: number; actor: number }): boolean {
  return counts.app < limits.app && counts.workspace < limits.workspace && counts.actor < limits.actor;
}

export function streamSnapshot(workspaces: Map<string,number>): Record<string,number> { return Object.fromEntries(workspaces); }
