// Cookie-bearing Eden client used by the dashboard and HTTP integration tests.
import { treaty } from "@elysiajs/eden";
import type { App } from "../../server/app.ts";

export function createApi(origin: string, fetcher: typeof fetch = fetch) {
  return treaty<App>(origin, { fetcher, fetch: { credentials: "include" }, parseDate: false });
}
