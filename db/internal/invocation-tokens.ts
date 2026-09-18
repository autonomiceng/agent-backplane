// Temporary authority catalog; only closed invocation definers mutate these rows.
import { sql } from "drizzle-orm";
import { check, customType, index, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";
import { runs } from "./runs.ts";
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
export const invocationTokens = pgSchema("control").table("invocation_tokens", {
  tokenHash: bytea("token_hash").primaryKey(), runId: uuid("run_id").notNull().unique().references(() => runs.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), restoreEpoch: uuid("restore_epoch"),
}, (t) => [check("invocation_tokens_token_hash_check", sql`octet_length(${t.tokenHash})=32`), index("invocation_token_expiry").on(t.expiresAt)]);
