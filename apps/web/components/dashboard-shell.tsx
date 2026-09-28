// Shared dashboard layout for routed screens: the platform-ui kit header above the screen.
import type { ReactNode } from "react";

// The server adds this tag when BP_PLATFORM_URL names the Edge console; a standalone install has none.
function configuredPlatformUrl(): string | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLMetaElement>('meta[name="bp-platform-url"]')?.content ?? null;
}

export function DashboardShell({ children, platformUrl = configuredPlatformUrl() }: { children: ReactNode; platformUrl?: string | null }): ReactNode {
  const platform = platformUrl && /^https?:\/\/[^/]+$/.test(platformUrl) ? `${platformUrl}/` : null;
  return <><header className="pk-header">
    <a className="pk-brand" href="/dashboard/"><svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="9" y="15" width="6" height="6" rx="1"/><path d="M6 9v3h12V9M12 12v3"/></svg>Agent Backplane</a>
    <nav className="pk-header-links" aria-label="Links">
      {platform && <a href={platform}>Platform</a>}
      <a href="/dashboard/">Workspaces</a>
      <a href="https://github.com/autonomiceng/agent-backplane" target="_blank" rel="noreferrer"><svg aria-hidden="true" fill="currentColor" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656"/></svg><span className="pk-sr-only">agent-backplane on </span>GitHub ↗</a>
    </nav>
  </header><main>{children}</main></>;
}
