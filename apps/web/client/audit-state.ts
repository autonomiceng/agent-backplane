// Pure timeline transitions; the stream adapter executes the returned transport effects.
import type { AuditPage } from "../../server/events/read-audit-input.ts";
import type { streamReady } from "../../server/events/stream-audit-input.ts";

export type AuditEvent = AuditPage["events"][number];
export type Ready = typeof streamReady.static;
export type TimelineState = {
  workspaceId: string; runId: string; epoch: number;
  phase: "connecting" | "live" | "reconnecting" | "resync";
  generation: string | null; after: string; head: string;
  retentionFloor: string; resumeId: string | null;
  staged: AuditEvent[] | null; events: Map<string, AuditEvent>; error: string | null;
};
export type Action = { epoch: number } & (
  | { type: "history"; snapshot: Ready; events: AuditEvent[] }
  | { type: "ready"; ready: Ready; id: string }
  | { type: "audit"; event: AuditEvent; id: string }
  | { type: "disconnected" }
  | { type: "expired" }
  | { type: "failed"; error: string }
);
type Effect = "resync" | "stop";

export function initialTimeline(workspaceId: string, runId: string): TimelineState {
  return { workspaceId, runId, epoch: 0, phase: "connecting", generation: null, after: "0", head: "0",
    retentionFloor: "0", resumeId: null, staged: null, events: new Map(), error: null };
}

export function eventId(workspaceId: string, generation: string, position: string): string {
  return `v1:${workspaceId}:${generation}:${position}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) return false;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((value: unknown, index) => sameJson(value, right[index]));
  }
  if (Array.isArray(right)) return false;
  const entries = new Map<string, unknown>(Object.entries(right));
  const leftEntries: [string, unknown][] = Object.entries(left);
  return leftEntries.length === entries.size
    && leftEntries.every(([key, value]) => entries.has(key) && sameJson(value, entries.get(key)));
}

export function reduceAudit(state: TimelineState, action: Action): { state: TimelineState; effects: Effect[] } {
  if (action.epoch !== state.epoch || state.error) return { state, effects: [] };
  const expire = (): { state: TimelineState; effects: Effect[] } => ({
    state: { ...initialTimeline(state.workspaceId, state.runId), epoch: state.epoch + 1, phase: "resync" },
    effects: ["resync"],
  });
  switch (action.type) {
    case "expired": return expire();
    case "failed": return { state: { ...state, error: action.error }, effects: ["stop"] };
    case "disconnected": return { state: { ...state, epoch: state.epoch + 1,
      phase: state.phase === "resync" ? "resync" : "reconnecting" }, effects: [] };
    case "history":
      return { state: { ...state, generation: action.snapshot.generation, after: action.snapshot.head,
        head: action.snapshot.head, retentionFloor: action.snapshot.retentionFloor, staged: action.events,
        resumeId: eventId(state.workspaceId, action.snapshot.generation, action.snapshot.head) }, effects: [] };
    case "ready": {
      const ready = action.ready;
      if (ready.generation !== state.generation || ready.after !== state.after
        || action.id !== eventId(state.workspaceId, ready.generation, ready.after)
        || BigInt(ready.retentionFloor) > BigInt(state.after) || BigInt(ready.head) < BigInt(state.after)
        || (state.staged !== null && ready.retentionFloor !== state.retentionFloor)) return expire();
      const events = state.staged === null ? state.events : new Map(state.staged
        .filter((event) => event.run_id === state.runId && BigInt(event.position) <= BigInt(state.after))
        .map((event) => [eventId(state.workspaceId, ready.generation, event.position), event]));
      return { state: { ...state, staged: null, events, head: ready.head,
        phase: BigInt(state.after) >= BigInt(ready.head) ? "live" : "reconnecting" }, effects: [] };
    }
    case "audit": {
      if (!state.generation || state.staged !== null
        || action.id !== eventId(state.workspaceId, state.generation, action.event.position)) return expire();
      const existing = state.events.get(action.id);
      if (existing && !sameJson(existing, action.event)) {
        return { state: { ...state, error: "protocol_error" }, effects: ["stop"] };
      }
      const events = new Map(state.events);
      if (!existing && action.event.run_id === state.runId) events.set(action.id, action.event);
      const advances = BigInt(action.event.position) > BigInt(state.after);
      const after = advances ? action.event.position : state.after;
      return { state: { ...state, events, after, resumeId: advances ? action.id : state.resumeId,
        phase: BigInt(after) >= BigInt(state.head) ? "live" : "reconnecting" }, effects: [] };
    }
  }
}

export function timelineEvents(state: TimelineState): [string, AuditEvent][] {
  return [...state.events].sort(([, a], [, b]) => BigInt(a.position) < BigInt(b.position) ? -1
    : BigInt(a.position) > BigInt(b.position) ? 1 : 0);
}
