// Integration assertions render the production inbox with its production callbacks.
import { renderToStaticMarkup } from "react-dom/server";
import type { ApprovalInboxClient } from "../client/approval-inbox.ts";
import { Routes } from "../routes.tsx";
import { ApprovalInboxView } from "../screens/approval-inbox.tsx";
export function renderApprovalInbox(client: ApprovalInboxClient): string {
  return renderToStaticMarkup(<ApprovalInboxView state={client.getSnapshot()} actions={client} />);
}
export function renderApprovalRoute(workspaceId: string): string {
  return renderToStaticMarkup(<Routes url={new URL(`http://localhost/dashboard/workspaces/${workspaceId}/approvals`)} />);
}
