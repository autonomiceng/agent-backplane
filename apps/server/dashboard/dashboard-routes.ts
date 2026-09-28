// Serves the Vite build from the combined server; only flat JS/CSS assets reach the filesystem.
import { existsSync } from "node:fs";
import { Elysia } from "elysia";
import { ConfigError, normalizeOrigin } from "../platform/config.ts";

// BP_PLATFORM_URL names the Edge console for the dashboard's Platform link; unset means standalone.
export function readPlatformUrl(env: Record<string, string | undefined>): string | null {
  if (!env.BP_PLATFORM_URL) return null;
  try { return normalizeOrigin(env.BP_PLATFORM_URL); }
  catch { throw new ConfigError("BP_PLATFORM_URL must be an absolute HTTP(S) origin without credentials, path, query or fragment"); }
}

export function dashboardRoutes(root: URL, production = false, platformUrl: string | null = null) {
  if (production && !existsSync(new URL("index.html", root))) throw new Error("Dashboard build unavailable");
  // Injected at serve time so a published image picks up the setting without a rebuild.
  const platformMeta = platformUrl ? `<meta name="bp-platform-url" content="${Bun.escapeHTML(platformUrl)}">` : "";
  const serve = async (request: Request) => {
    const path = new URL(request.url).pathname;
    const asset = /^\/dashboard\/assets\/([a-zA-Z0-9_-]+\.(?:js|css))$/.exec(path)?.[1];
    if (path.startsWith("/dashboard/assets") && !asset) return new Response("Not found", { status: 404 });
    const file = Bun.file(new URL(asset ? `assets/${asset}` : "index.html", root));
    if (!await file.exists()) return new Response(asset ? "Not found" : "Dashboard build unavailable",
      { status: asset ? 404 : 503 });
    if (asset) return new Response(file, { headers: { "cache-control": "public, max-age=31536000, immutable" } });
    if (!platformMeta) return new Response(file, { headers: { "cache-control": "no-cache" } });
    return new Response((await file.text()).replace("</head>", `${platformMeta}</head>`),
      { headers: { "cache-control": "no-cache", "content-type": "text/html;charset=utf-8" } });
  };
  return new Elysia({ name: "dashboard" })
    // The browser origin lands on the dashboard only while a build is there to serve.
    .get("/", async () => await Bun.file(new URL("index.html", root)).exists()
      ? new Response(null, { status: 302, headers: { location: "/dashboard/" } })
      : new Response("Not found", { status: 404 }), { detail: { hide: true } })
    .get("/dashboard", ({ request }) => serve(request), { detail: { hide: true } })
    .get("/dashboard/*", ({ request }) => serve(request), { detail: { hide: true } });
}
