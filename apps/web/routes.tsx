// Selects dashboard screens; main.tsx supplies the browser URL.
import type { ReactNode } from "react";
import { DashboardShell } from "./components/dashboard-shell.tsx";
import { RunTimeline } from "./screens/run-timeline.tsx";
import { ApprovalInbox } from "./screens/approval-inbox.tsx";
import { SignIn } from "./screens/sign-in.tsx";
import { Principals } from "./screens/principals.tsx";

export function Routes({ url }: { url: URL }): ReactNode {
  if (url.pathname === "/dashboard/sign-in") {
    return <SignIn returnTo={url.searchParams.get("returnTo")} />;
  }
  const approvalMatch = /^\/dashboard\/workspaces\/([^/]+)\/approvals\/?$/.exec(url.pathname);
  const approvalWorkspaceId = approvalMatch?.[1]?.toLowerCase();
  if (approvalWorkspaceId) {
    return <DashboardShell>
      <ApprovalInbox key={approvalWorkspaceId} workspaceId={approvalWorkspaceId} />
    </DashboardShell>;
  }
  const principals = /^\/dashboard\/workspaces\/([^/]+)\/principals\/?$/.exec(url.pathname);
  const principalsWorkspaceId = principals?.[1]?.toLowerCase();
  if (principalsWorkspaceId) {
    return <DashboardShell>
      <Principals key={principalsWorkspaceId} workspaceId={principalsWorkspaceId} />
    </DashboardShell>;
  }
  const match = /^\/dashboard\/workspaces\/([^/]+)\/runs\/([^/]+)\/?$/.exec(url.pathname);
  const workspaceId = match?.[1]?.toLowerCase();
  const runId = match?.[2]?.toLowerCase();
  return (
    <DashboardShell>
      {workspaceId && runId
        ? <RunTimeline key={`${workspaceId}:${runId}`} workspaceId={workspaceId} runId={runId} />
        : <p>Open a Run timeline link.</p>}
    </DashboardShell>
  );
}
