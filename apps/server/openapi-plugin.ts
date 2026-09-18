// Shared OpenAPI configuration for createApp and offline contract export.
import { openapi } from "@elysiajs/openapi";

export function openapiPlugin() {
  return openapi({
    path: "/api/openapi",
    documentation: {
      info: { title: "agent-backplane", version: "0.0.0" },
      components: {
        securitySchemes: {
          userSession: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
          principalKey: { type: "http", scheme: "bearer" },
        },
      },
    },
  });
}
