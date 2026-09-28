// Workspace Approvals display authoritative descriptors and separate local submission outcomes.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createApprovalInbox, type ApprovalInboxClient } from "../client/approval-inbox.ts";
import { approvalReasons, reasonPermitsDecision } from "../client/approval-reasons.ts";
import { inboxItems, type ApprovalState } from "../client/approval-state.ts";
export function ApprovalInbox({ workspaceId }: { workspaceId: string }): ReactNode {
  const [client, setClient] = useState<ApprovalInboxClient | null>(null);
  useEffect(() => {
    const next = createApprovalInbox(window.location.origin, workspaceId);
    setClient(next); next.start(document);
    return () => next.dispose();
  }, [workspaceId]);
  return client ? <SubscribedInbox client={client} /> : <p>Loading Approvals</p>;
}
function SubscribedInbox({ client }: { client: ApprovalInboxClient }): ReactNode {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return <ApprovalInboxView state={state} actions={client} />;
}
export function ApprovalInboxView({ state, actions }: { state: ApprovalState; actions: ApprovalInboxClient }): ReactNode {
  const items = inboxItems(state), loading = state.listId !== null;
  const deciding = Object.values(state.submissions).some((s) => s.phase === "deciding");
  return <section className="screen"><div className="toolbar"><h1>Approval inbox</h1>
    <button className="pk-button" disabled={loading || deciding} onClick={() => { void actions.refresh(); }}>Refresh</button></div>
    <p className="lead">Workspace: <code>{state.workspaceId}</code></p>
    {loading && <p role="status">Refreshing</p>}
    {state.observedAt && <p className="lead">Last checked {state.observedAt}</p>}
    {state.error && <p className="pk-notice" data-state="danger" role="alert">{state.error}</p>}
    {state.observedAt && !loading && !state.error && items.length === 0 && <p className="pk-notice">No pending Approvals.</p>}
    {items.map((item) => {
      const submission = state.submissions[item.id], reason = state.reasons[item.id] ?? "";
      const disabled = !!submission || item.decision !== null || item.expired;
      const [badge, label] = item.decision === "approve" ? ["ok", "Approved"] : item.decision === "reject" ? ["danger", "Rejected"]
        : item.expired ? ["disabled", "Expired"] : ["warn", "Pending"];
      return <article className="pk-card" key={item.id} aria-label={`Approval ${item.id}`} data-approval-id={item.id}><div className="stack">
        <div className="pk-app-head"><h3>Approval {item.id}</h3><span className="pk-badge" data-state={badge}>{label}</span></div>
        <div className="pk-endpoints">
          <div className="pk-endpoint"><span>Requested by</span><code>{item.requestedBy}</code></div>
          <div className="pk-endpoint"><span>Run</span><code><a href={`/dashboard/workspaces/${state.workspaceId}/runs/${item.requestedRunId}`}>Run {item.requestedRunId}</a></code></div>
          <div className="pk-endpoint"><span>Created</span><code>{item.createdAt}</code></div>
          <div className="pk-endpoint"><span>Expires</span><code>{item.expiresAt} ({item.expired ? "expired" : "unexpired at last check"})</code></div>
          <div className="pk-endpoint"><span>Target</span><code>{item.targetId}</code></div>
          <div className="pk-endpoint"><span>Version</span><code>{item.targetVersion}</code></div>
        </div>
        <pre>{JSON.stringify(item.target, null, 2)}</pre>
        {item.decision !== null && <p>Server decision: {item.decision}. Reason: {item.reason}. Position: {item.decisionPosition}.</p>}
        <div className="decide">
          <label>Reason <select className="pk-input" required value={reason} disabled={disabled} onChange={(event) => actions.reason(item.id, event.target.value)}>
            <option value="">Select a reason</option>
            {approvalReasons.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}
          </select></label>
          <button className="pk-button" disabled={disabled || !reasonPermitsDecision(reason, "approve")} onClick={() => { void actions.decide(item.id, "approve"); }}>Approve</button>
          <button className="pk-button pk-danger" disabled={disabled || !reasonPermitsDecision(reason, "reject")} onClick={() => { void actions.decide(item.id, "reject"); }}>Reject</button>
        </div>
        {submission?.phase === "deciding" && <p role="status">Deciding</p>}
        {submission?.error && <p className="pk-notice" data-state="danger" role="alert">{submission.phase}: {submission.status} {submission.error}</p>}
        {submission?.phase === "confirmed" && <div className="pk-notice" role="status"><p>200: {submission.result?.decision}</p>
          <p>Released Delivery: {submission.result?.releasedDeliveryId ?? "none"}</p></div>}
        {submission && ["failed", "unknown"].includes(submission.phase) && <button className="pk-button" onClick={() => actions.dismiss(item.id)}>Dismiss submission</button>}
      </div></article>;
    })}
    <nav className="pager" aria-label="Approval pages">
      <button className="pk-button" disabled={loading || deciding || state.pagination.page === 0} onClick={() => { void actions.previous(); }}>Previous</button>
      <span> Page {state.pagination.page + 1} </span>
      <button className="pk-button" disabled={loading || deciding || state.nextCursor === null} onClick={() => { void actions.next(); }}>Next</button>
    </nav>
  </section>;
}
