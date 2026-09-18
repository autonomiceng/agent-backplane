// Message-level Effect identity is immutable; Delivery transitions own execution state.
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, pgSchema, text, uuid } from "drizzle-orm/pg-core";
import { deliveries } from "./deliveries.ts";

export const effects = pgSchema("queue").table("effects", {
  workspaceId: uuid("workspace_id").notNull(),
  queue: text("queue").notNull(),
  messageId: uuid("message_id").primaryKey(),
  originDeliveryId: uuid("origin_delivery_id").notNull(),
  reset: boolean("reset").notNull().default(false),
  effectKey: text("effect_key").notNull(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.queue, table.messageId, table.originDeliveryId],
    foreignColumns: [deliveries.workspaceId, deliveries.queue, deliveries.messageId, deliveries.id] }),
  check("effects_effect_key_check", sql`${table.effectKey} ~ '^[0-9a-f]{64}$'`),
]);
