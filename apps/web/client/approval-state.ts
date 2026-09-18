// The inbox keeps local submission outcomes independently of authoritative list pages.
import type { Approval, ApprovalsPage } from "../../server/approvals/list-approvals-input.ts";
import type { decideResponse } from "../../server/approvals/decide-input.ts";
export type DecisionResult = typeof decideResponse.static;
export type Submission = { item: Approval; requestId: number; phase: "deciding" | "confirmed" | "failed" | "unknown";
  status: number | null; error: string | null; result: DecisionResult | null };
export type ApprovalState = {
  workspaceId: string; epoch: number; items: Approval[]; submissions: Record<string, Submission>; reasons: Record<string, string>;
  listId: number | null; pagination: { cursors: (string | undefined)[]; page: number };
  pendingPage: ApprovalState["pagination"] | null; nextCursor: string | null; observedAt: string | null; error: string | null;
};
export type ApprovalAction = { type: "reset"; workspaceId: string; epoch: number }
  | { type: "list-start"; epoch: number; requestId: number; pagination: ApprovalState["pagination"] }
  | { type: "list-cancel"; epoch: number; requestId: number }
  | { type: "list-result"; epoch: number; requestId: number; result: ApprovalsPage | string }
  | { type: "reason"; epoch: number; id: string; reason: string }
  | { type: "dismiss"; epoch: number; id: string }
  | { type: "decide-start"; epoch: number; requestId: number; item: Approval }
  | { type: "decide-result"; epoch: number; requestId: number; id: string; outcome: Pick<Submission, "phase" | "status" | "error" | "result"> };
export function initialApprovals(workspaceId: string, epoch = 0): ApprovalState {
  return { workspaceId, epoch, items: [], submissions: {}, reasons: {}, listId: null,
    pagination: { cursors: [undefined], page: 0 }, pendingPage: null, nextCursor: null, observedAt: null, error: null };
}
export function inboxItems(state: ApprovalState): Approval[] {
  return [...state.items, ...Object.values(state.submissions).filter((s) => !state.items.some((item) => item.id === s.item.id)).map((s) => s.item)];
}
export function reduceApprovals(state: ApprovalState, action: ApprovalAction): ApprovalState {
  if (action.type === "reset") return action.epoch > state.epoch ? initialApprovals(action.workspaceId, action.epoch) : state;
  if (action.epoch !== state.epoch) return state;
  switch (action.type) {
    case "list-start":
      if (Object.values(state.submissions).some((s) => s.phase === "deciding")) return state;
      return { ...state, listId: action.requestId, pendingPage: action.pagination, error: null };
    case "list-cancel":
      return state.listId === action.requestId ? { ...state, listId: null, pendingPage: null } : state;
    case "list-result":
      if (state.listId !== action.requestId || !state.pendingPage) return state;
      if (typeof action.result === "string") return { ...state, listId: null, pendingPage: null, error: action.result };
      if (action.result.items.some((item) => item.workspaceId !== state.workspaceId)) return state;
      return { ...state, items: action.result.items, nextCursor: action.result.nextCursor, observedAt: action.result.observedAt,
        pagination: state.pendingPage, pendingPage: null, listId: null, error: null };
    case "reason":
      return state.submissions[action.id] ? state : { ...state, reasons: { ...state.reasons, [action.id]: action.reason } };
    case "dismiss": {
      const submission = state.submissions[action.id];
      if (!submission || submission.phase === "deciding" || submission.phase === "confirmed") return state;
      const submissions = { ...state.submissions }; delete submissions[action.id];
      return { ...state, submissions };
    }
    case "decide-start":
      if (action.item.workspaceId !== state.workspaceId || action.item.decision !== null || state.submissions[action.item.id]) return state;
      return { ...state, listId: null, pendingPage: null, submissions: { ...state.submissions,
        [action.item.id]: { item: action.item, requestId: action.requestId, phase: "deciding", status: null, error: null, result: null } } };
    case "decide-result": {
      const submission = state.submissions[action.id];
      if (submission?.phase !== "deciding" || submission.requestId !== action.requestId
        || (action.outcome.result !== null && action.outcome.result.id !== action.id)) return state;
      return { ...state, submissions: { ...state.submissions, [action.id]: { ...submission, ...action.outcome } } };
    }
  }
}
