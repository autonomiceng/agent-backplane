// Workspace key metadata and explicit Principal revocation, shared with integration rendering.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPrincipals, type PrincipalsClient } from "../client/principals.ts";
import type { PrincipalsState } from "../client/principals-state.ts";

function Timestamp({ value, empty }: { value: string | null | undefined; empty: string }): ReactNode {
  if (!value) return empty;
  const date = new Date(value);
  return <time dateTime={value} title={value}><span>{date.toLocaleDateString(undefined, { dateStyle: "medium" })}</span><span>{date.toLocaleTimeString(undefined, { timeStyle: "short" })}</span></time>;
}

export function Principals({ workspaceId }: { workspaceId: string }): ReactNode {
  const [client, setClient] = useState<PrincipalsClient | null>(null);
  useEffect(() => {
    const next = createPrincipals(window.location.origin, workspaceId);
    setClient(next);
    void next.refresh();
    return () => next.dispose();
  }, [workspaceId]);
  return client ? <SubscribedPrincipals client={client} /> : <p>Loading Principals</p>;
}

function SubscribedPrincipals({ client }: { client: PrincipalsClient }): ReactNode {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return <PrincipalsView state={state} actions={client} />;
}

export function PrincipalsView({ state, actions }: { state: PrincipalsState; actions: PrincipalsClient }): ReactNode {
  const selected = state.revocation;
  const pending = selected?.phase === "pending";
  const loading = state.listRequestId !== null;
  return <section>
    <h1>Principals</h1><p>Workspace: {state.workspaceId}</p>
    <p>Last use is recorded at most once per minute and reflects authenticated use, including requests whose later operation fails.
      Rotation resets last use and preserves First issued. Refresh to see current metadata.</p>
    <button disabled={pending || loading} onClick={() => { void actions.refresh(); }}>Refresh</button>
    {loading && <p role="status">Loading Principals</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.loaded && !loading && !state.error && state.items.length === 0 && <p>No Principals.</p>}
    <p className="table-help" id="principal-table-help">Scroll the table horizontally to see all key details and actions on smaller screens.</p>
    <div className="table-scroll" role="region" aria-label="Principal key metadata" aria-describedby="principal-table-help" tabIndex={0}><table><thead><tr><th>Name</th><th>ID</th><th>Key prefix</th><th>First issued</th><th>Last use</th><th>Rotated</th><th>Status</th><th>Revoked</th><th>Action</th></tr></thead>
      <tbody>{state.items.map((principal) => <tr key={principal.id}>
        <td>{principal.name}</td><td>{principal.id}</td><td>{principal.credential?.prefix ?? "No key issued"}</td>
        <td><Timestamp value={principal.credential?.createdAt} empty="No key issued" /></td>
        <td><Timestamp value={principal.credential?.lastUsedAt} empty={principal.credential ? "No use recorded for current key" : "No key issued"} /></td>
        <td><Timestamp value={principal.credential?.rotatedAt} empty="Never rotated" /></td><td>{principal.status}</td><td><Timestamp value={principal.credential?.revokedAt} empty="—" /></td>
        <td><button className="danger" disabled={pending || principal.status === "revoked"} onClick={() => actions.select(principal)}>Revoke {principal.name}</button></td>
      </tr>)}</tbody></table></div>
    <nav aria-label="Principal pages">
      <button disabled={pending || loading || state.page === 0} onClick={() => { void actions.previous(); }}>Previous</button>
      <span> Page {state.page + 1} </span>
      <button disabled={pending || loading || state.nextCursor === null} onClick={() => { void actions.next(); }}>Next</button>
    </nav>
    {selected && <section aria-label="Principal revocation">
      <h2>Revoke {selected.principal.name}</h2>
      <p>Principal: {selected.principal.id}. Displayed key prefix: {selected.principal.credential?.prefix ?? "No key issued"}.</p>
      {selected.phase === "confirming" && <>
        <p>Revocation affects this Principal’s current key, invalidates Receipts, and pauses begun Effects whose outcomes remain unresolved.
          Already-bound transactions may finish.</p>
        <button className="danger" onClick={() => { void actions.confirm(); }}>Confirm revocation</button>
        <button onClick={actions.cancel}>Cancel</button>
      </>}
      {pending && <p role="status">Revoking</p>}
      {selected.error && <p role="alert">{selected.error}</p>}
      {(selected.phase === "failed" || selected.phase === "outcome-unknown") && <button onClick={() => actions.select(selected.principal)}>Retry revocation</button>}
      {selected.phase !== "confirming" && !pending && <button onClick={actions.cancel}>Close</button>}
      {selected.phase === "confirmed" && <div role="status"><p>Principal revoked.</p>
        <p>{selected.effectsPausedThisRequest} Effects paused by this request.</p>
        <p>Zero does not describe Effects paused by earlier requests.</p></div>}
    </section>}
  </section>;
}
