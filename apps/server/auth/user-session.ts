// Tenancy routes opt into the user macro to resolve a human session from request headers.
import { Elysia } from "elysia";
import type { Auth } from "./auth.ts";

export function userSession(auth: Auth, authUrl: string) {
  const trustedOrigin = new URL(authUrl).origin;
  return new Elysia({ name: "user-session" }).macro({
    user: {
      beforeHandle({ request, status }) {
        if (request.method === "GET" || request.method === "HEAD") return;
        const origin = request.headers.get("origin");
        const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        if ((origin !== trustedOrigin && (origin !== null || request.headers.has("cookie"))) || (request.body !== null && contentType !== "application/json")) {
          return status(403, { error: "origin_forbidden" });
        }
      },
      async resolve({ request, status }) {
        const session = await auth.api.getSession({ headers: request.headers });
        if (!session) return status(401, { error: "unauthorized" });
        return { user: session.user };
      },
    },
  });
}
