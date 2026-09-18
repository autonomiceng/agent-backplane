// main.ts injects the shared pool and config; Better Auth owns global identity writes outside Run context.
import { isPublicOrigin, signupPolicy } from "./signup-policy.ts";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import * as schema from "../../../db/internal/auth.ts";
import type { Config } from "../platform/config.ts";
import type { Pool } from "../platform/pool.ts";

export function createAuth(pool: Pool, config: Pick<Config, "publicOrigin" | "authSecret"> & Partial<Pick<Config, "signup">>,
  database: BunSQLDatabase<typeof schema> = drizzle({ client: pool, schema }), autoSignIn = true, afterUser?: () => Promise<void>) {
  const effective = signupPolicy(config.signup ?? "closed", isPublicOrigin(config.publicOrigin));
  return betterAuth({
    baseURL: config.publicOrigin,
    secret: config.authSecret,
    trustedOrigins: [config.publicOrigin],
    // Better Auth defaults to skipping origin checks in NODE_ENV=test; pin the same checks in every environment.
    advanced: { disableOriginCheck: false, disableCSRFCheck: false,
      trustedProxyHeaders: false, useSecureCookies: config.publicOrigin.startsWith("https:"), ipAddress: { ipAddressHeaders: [] } },
    database: drizzleAdapter(database, { provider: "pg", schema, camelCase: true, transaction: true }),
    disabledPaths: [
      ...(effective === "open" ? [] : ["/sign-up/email"]),
      "/organization/create",
      "/organization/update",
      "/organization/delete",
      "/organization/leave",
      "/organization/invite-member",
      "/organization/accept-invitation",
      "/organization/reject-invitation",
      "/organization/cancel-invitation",
      "/organization/remove-member",
      "/organization/update-member-role",
    ],
    emailAndPassword: { enabled: true, autoSignIn },
    // Better Auth defers after hooks until savepoint release; this barrier must precede the credential insert.
    databaseHooks: { account: { create: { before: async () => { await afterUser?.(); } } } },
    plugins: [organization({ allowUserToCreateOrganization: false })],
  });
}

export type Auth = ReturnType<typeof createAuth>;
