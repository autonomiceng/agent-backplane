// Shared dashboard layout for routed screens.
import type { ReactNode } from "react";

export function DashboardShell({ children }: { children: ReactNode }): ReactNode {
  return <><header><a href="/dashboard/">Backplane</a></header><main>{children}</main></>;
}
