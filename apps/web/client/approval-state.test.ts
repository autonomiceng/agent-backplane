import { expect, test } from "bun:test";
import type { Approval } from "../../server/approvals/list-approvals-input.ts";
import { initialApprovals, reduceApprovals, inboxItems } from "./approval-state.ts";

test("late refreshes erase decision conflicts or restore pending after success", () => {
  const item: Approval = { id: "conflict", workspaceId: "w", requestedBy: "p", requestedRunId: "r",
    createdAt: "2026-09-14T00:00:00Z", expiresAt: "2026-09-15T00:00:00Z", expired: false,
    targetId: "d", targetVersion: "v", target: { kind: "message", queue: "q", messageId: "m", deliveryId: "d" },
    decision: null, reason: null, decisionPosition: null, releasedDeliveryId: null };
  const success = { ...item, id: "success" }, pagination = { cursors: [undefined], page: 0 };
  const page = { items: [item, success], nextCursor: null, observedAt: item.createdAt };
  let state = initialApprovals("w");
  state = reduceApprovals(state, { type: "list-start", epoch: 0, requestId: 1, pagination });
  state = reduceApprovals(state, { type: "list-result", epoch: 0, requestId: 1, result: page });
  state = reduceApprovals(state, { type: "reason", epoch: 0, id: item.id, reason: "reviewed" });
  state = reduceApprovals(state, { type: "list-start", epoch: 0, requestId: 2, pagination });
  state = reduceApprovals(state, { type: "decide-start", epoch: 0, requestId: 3, item });
  expect(reduceApprovals(state, { type: "list-result", epoch: 0, requestId: 2, result: page })).toEqual(state);
  state = reduceApprovals(state, { type: "decide-result", epoch: 0, requestId: 3, id: item.id,
    outcome: { phase: "failed", status: 409, error: "approval_decided", result: null } });
  const conflict = state.submissions[item.id];
  expect(reduceApprovals(state, { type: "list-result", epoch: 0, requestId: 2, result: page })).toEqual(state);
  state = reduceApprovals(state, { type: "list-start", epoch: 0, requestId: 4, pagination });
  state = reduceApprovals(state, { type: "list-result", epoch: 0, requestId: 4, result: { ...page, items: [success] } });
  expect(inboxItems(state).map((entry) => entry.id)).toEqual([success.id, item.id]);
  expect(state.submissions[item.id]).toEqual(conflict);
  expect(state.reasons[item.id]).toBe("reviewed");
  state = reduceApprovals(state, { type: "list-start", epoch: 0, requestId: 5, pagination });
  state = reduceApprovals(state, { type: "decide-start", epoch: 0, requestId: 6, item: success });
  const outcome = { phase: "confirmed", status: 200, error: null,
    result: { id: success.id, decision: "approve", releasedDeliveryId: "new-delivery" } } as const;
  state = reduceApprovals(state, { type: "decide-result", epoch: 0, requestId: 6, id: success.id, outcome });
  expect(reduceApprovals(state, { type: "list-result", epoch: 0, requestId: 5, result: page })).toEqual(state);
  state = reduceApprovals(state, { type: "list-start", epoch: 0, requestId: 7, pagination });
  state = reduceApprovals(state, { type: "list-result", epoch: 0, requestId: 7, result: page });
  expect(state.submissions[success.id]).toMatchObject(outcome);
  state = reduceApprovals(state, { type: "list-start", epoch: 0, requestId: 8, pagination });
  state = reduceApprovals(state, { type: "list-result", epoch: 0, requestId: 8, result: { ...page, items: [] } });
  expect(inboxItems(state).map((entry) => entry.id)).toEqual([item.id, success.id]);
  expect(state.submissions[success.id]).toMatchObject(outcome);
  expect(state.submissions[item.id]).toEqual(conflict);
  state = reduceApprovals(state, { type: "reset", epoch: 1, workspaceId: "other" });
  state = reduceApprovals(state, { type: "list-start", epoch: 1, requestId: 9, pagination });
  expect(reduceApprovals(state, { type: "list-result", epoch: 0, requestId: 9, result: page })).toEqual(state);
  expect(reduceApprovals(state, { type: "decide-result", epoch: 0, requestId: 6, id: success.id, outcome })).toEqual(state);
  expect(state.submissions).toEqual({});
  state = reduceApprovals(state, { type: "list-result", epoch: 1, requestId: 9, result: page });
  expect(state).toMatchObject({ listId: null, pendingPage: null, error: "approval_workspace_mismatch", items: [] });
  state = reduceApprovals(state, { type: "list-start", epoch: 1, requestId: 9, pagination });
  state = reduceApprovals(state, { type: "list-cancel", epoch: 1, requestId: 9 });
  expect(state).toMatchObject({ listId: null, pendingPage: null, error: null });
  expect(reduceApprovals(state, { type: "list-result", epoch: 1, requestId: 9, result: "approval_unavailable" })).toEqual(state);
  expect(reduceApprovals(state, { type: "list-result", epoch: 1, requestId: 9, result: { ...page, items: [] } })).toEqual(state);
});
