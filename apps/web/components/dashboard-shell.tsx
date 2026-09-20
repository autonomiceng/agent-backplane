// Shared dashboard layout for routed screens.
import type { ReactNode } from "react";

export function DashboardShell({ children }: { children: ReactNode }): ReactNode {
  return <><header><a className="brand" href="/dashboard/">Backplane</a><nav aria-label="Dashboard"><a href="/dashboard/">Workspaces</a></nav></header><main>{children}</main></>;
}
