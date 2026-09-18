import { expect, test } from "bun:test";
import { eventId, initialTimeline, reduceAudit, timelineEvents, type Action, type AuditEvent } from "./audit-state.ts";

test("reconnect duplicates entries or retains an expired generation and stale callbacks", () => {
  let state = initialTimeline("workspace", "selected");
  const send = (action: Omit<Action, "epoch"> & Partial<Action>) => {
    const result = reduceAudit(state, { ...action, epoch: action.epoch ?? state.epoch } as Action);
    state = result.state;
    return result.effects;
  };
  const event = (position: string, run_id = "selected"): AuditEvent => ({
    position, run_id, kind: "sql.execute", objects: ["items"], row_count: "1",
    occurred_at: "2026-09-14T00:00:00.000Z", principal_id: null, user_id: null, metadata: {},
  });
  const snapshot = { generation: "old", after: "0", head: "9007199254740993", retentionFloor: "0" };
  send({ type: "history", snapshot, events: [event("10"), event("2"), event(snapshot.head)] });
  expect(timelineEvents(state)).toHaveLength(0);
  send({ type: "ready", ready: { ...snapshot, after: snapshot.head, head: "9007199254740995" },
    id: eventId("workspace", "old", snapshot.head) });
  expect(state.phase).toBe("reconnecting");
  const audit = (position: string, runId = "selected") => send({
    type: "audit", event: event(position, runId), id: eventId("workspace", "old", position),
  });
  audit("9007199254740994");
  audit("9007199254740994");
  audit("9007199254740995", "other");
  expect(state.phase).toBe("live");
  expect(state.after).toBe("9007199254740995");
  expect(state.resumeId).toBe(eventId("workspace", "old", "9007199254740995"));
  expect(timelineEvents(state).map(([, row]) => row.position)).toEqual(["2", "10", "9007199254740993", "9007199254740994"]);
  const oldEpoch = state.epoch;
  send({ type: "disconnected" });
  expect(state.phase).toBe("reconnecting");
  send({ type: "ready", ready: { ...snapshot, after: state.after, head: state.after }, id: state.resumeId ?? "" });
  audit("9007199254740994");
  expect(state.after).toBe("9007199254740995");
  expect(timelineEvents(state)).toHaveLength(4);
  expect(send({ type: "expired" })).toEqual(["resync"]);
  expect(state.phase).toBe("resync");
  expect(timelineEvents(state)).toHaveLength(0);
  const replacement = { generation: "new", after: "0", head: "3", retentionFloor: "0" };
  send({ type: "history", snapshot: replacement, events: [event("3"), event("1", "other")] });
  send({ type: "audit", epoch: oldEpoch, event: event("99"), id: eventId("workspace", "old", "99") });
  send({ type: "ready", epoch: oldEpoch, ready: snapshot, id: "stale" });
  expect(timelineEvents(state)).toHaveLength(0);
  send({ type: "ready", ready: { ...replacement, after: "3" }, id: eventId("workspace", "new", "3") });
  expect(state.phase).toBe("live");
  expect(timelineEvents(state).map(([id]) => id)).toEqual([eventId("workspace", "new", "3")]);
  send({ type: "disconnected", epoch: oldEpoch });
  expect(state.phase).toBe("live");
  const accepted = state.events.get(eventId("workspace", "new", "3"));
  const conflict = reduceAudit(state, { type: "audit", epoch: state.epoch,
    event: { ...event("3"), metadata: { changed: true } }, id: eventId("workspace", "new", "3") });
  expect(conflict.state.error).toBe("protocol_error");
  expect(conflict.effects).toEqual(["stop"]);
  expect(conflict.state.events.get(eventId("workspace", "new", "3"))).toBe(accepted);
  send({ type: "history", snapshot: replacement, events: [event("3")] });
  expect(send({ type: "ready", ready: { ...replacement, after: "3", retentionFloor: "1" },
    id: eventId("workspace", "new", "3") })).toEqual(["resync"]);
});
