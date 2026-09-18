// Serves the Vite build from the combined server; only flat JS/CSS assets reach the filesystem.
import { existsSync } from "node:fs";
import { Elysia } from "elysia";

export function dashboardRoutes(root: URL, production = false) {
  if (production && !existsSync(new URL("index.html", root))) throw new Error("Dashboard build unavailable");
  const serve = async (request: Request) => {
    const path = new URL(request.url).pathname;
    const asset = /^\/dashboard\/assets\/([a-zA-Z0-9_-]+\.(?:js|css))$/.exec(path)?.[1];
    if (path.startsWith("/dashboard/assets") && !asset) return new Response("Not found", { status: 404 });
    const file = Bun.file(new URL(asset ? `assets/${asset}` : "index.html", root));
    if (!await file.exists()) return new Response(asset ? "Not found" : "Dashboard build unavailable",
      { status: asset ? 404 : 503 });
    return new Response(file, { headers: { "cache-control": asset ? "public, max-age=31536000, immutable" : "no-cache" } });
  };
  return new Elysia({ name: "dashboard" })
    .get("/dashboard", ({ request }) => serve(request), { detail: { hide: true } })
    .get("/dashboard/*", ({ request }) => serve(request), { detail: { hide: true } });
}
