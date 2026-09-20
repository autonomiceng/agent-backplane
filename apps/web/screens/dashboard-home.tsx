import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createDashboardHome, type DashboardHomeClient, type DashboardHomeState } from "../client/dashboard-home.ts";

export function DashboardHome(): ReactNode {
  const [client, setClient] = useState<DashboardHomeClient | null>(null);
  useEffect(() => {
    const next = createDashboardHome(window.location.origin);
    setClient(next);
    void next.refresh();
    return () => next.dispose();
  }, []);
  return client ? <SubscribedHome client={client} /> : <p role="status">Loading Workspaces…</p>;
}

function SubscribedHome({ client }: { client: DashboardHomeClient }): ReactNode {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return <DashboardHomeView state={state} actions={client} />;
}

export function DashboardHomeView({ state, actions }: { state: DashboardHomeState; actions: DashboardHomeClient }): ReactNode {
  return <section>
    <h1>Backplane</h1>
    <p>A shared place for your agents to store state, pass work through Queues, and record what each Run changed.</p>
    <h2>Workspaces</h2>
    {state.status === "loading" && <p role="status">Loading Workspaces…</p>}
    {state.status === "signed-out" && <p>Sign in to see your Workspaces and manage agent access. <a href="/dashboard/sign-in?returnTo=%2Fdashboard%2F">Sign in</a></p>}
    {state.status === "error" && <>
      <p role="alert">Workspaces could not be loaded. Try again. If this continues, contact the person who runs this Backplane.</p>
      <button onClick={() => { void actions.refresh(); }}>Try again</button>
    </>}
    {state.status === "ready" && <>
      <p>A Workspace keeps its schemas, Queues, and audit history together. Choose Principals to inspect agent keys or Approvals to decide pending requests.</p>
      <button onClick={() => { void actions.refresh(); }}>Refresh Workspaces</button>
      {state.workspaces.length === 0
        ? <p>{state.page === 0 ? "No Workspaces are available to your account. Ask the person who runs this Backplane to check your Organization access and Workspace setup." : "No more Workspaces. Refresh to see your current access."}</p>
        : <ul className="workspace-list">{state.workspaces.map(workspace => <li key={workspace.id}>
          <h3>{workspace.name}</h3>
          <p>Workspace ID: <code>{workspace.id}</code></p>
          <nav aria-label={`${workspace.name} Workspace`}>
            <a href={`/dashboard/workspaces/${encodeURIComponent(workspace.id)}/principals`}>Principals</a>{" · "}
            <a href={`/dashboard/workspaces/${encodeURIComponent(workspace.id)}/approvals`}>Approvals</a>
          </nav>
        </li>)}</ul>}
      <nav aria-label="Workspace pages">
        <button disabled={state.page === 0} onClick={() => { void actions.previous(); }}>Previous</button>
        <span> Page {state.page + 1} </span>
        <button disabled={state.nextCursor === null} onClick={() => { void actions.next(); }}>Next</button>
      </nav>
    </>}
    <section aria-labelledby="connect-agent">
      <h2 id="connect-agent">Connect an agent</h2>
      <p>Each agent uses a Principal with its own key in a Workspace. If you completed bootstrap, add the emitted <code>mcpServers.backplane</code> configuration to your Harness. It runs <code>bp mcp</code> locally using your private credential file.</p>
      <p>For the CLI, set <code>BP_CREDENTIALS_FILE</code> to that file. Existing key-based setups use <code>BP_URL</code>, <code>BP_KEY</code>, and <code>BP_WORKSPACE_ID</code>.</p>
      <p><a href="https://github.com/autonomiceng/agent-backplane/blob/main/infra/bootstrap/README.md">Bootstrap and credential setup</a>{" · "}
        <a href="https://github.com/autonomiceng/agent-backplane/blob/main/skills/backplane/SKILL.md">Agent CLI guide</a></p>
      <p>Open a Run timeline link from your agent to inspect that Run’s activity.</p>
    </section>
  </section>;
}
