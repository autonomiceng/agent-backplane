// Durable terminal-audit work, independent of temporary invocation authority.
import { index, pgSchema, timestamp, uuid } from "drizzle-orm/pg-core";
import { runs } from "./runs.ts";
export const invocationPending = pgSchema("control").table("invocation_pending", {
  runId: uuid("run_id").primaryKey().references(() => runs.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => [index("invocation_pending_expiry").on(t.expiresAt, t.runId)]);
