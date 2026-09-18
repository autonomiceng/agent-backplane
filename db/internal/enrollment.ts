// The immutable initial authority claim; identity creation and membership share its transaction.
import { sql } from "drizzle-orm";
import { boolean, check, customType, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
export const enrollment = pgSchema("control").table("enrollment", {
  singleton: boolean("singleton").primaryKey().default(true),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
  capabilityHash: bytea("capability_hash"),
}, (t) => [check("enrollment_singleton_check", sql`${t.singleton}`),
  check("enrollment_capability_hash_check", sql`${t.capabilityHash} IS NULL OR octet_length(${t.capabilityHash}) = 32`)]);
