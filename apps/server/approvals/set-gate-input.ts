// User gate declarations cover row UPDATE/DELETE or Workspace Migration apply.
import { t } from "elysia";
export const setGateInput = t.Object({ targetKind: t.Union([t.Literal("row"), t.Literal("migration")]), selector: t.String({ minLength: 1, maxLength: 128 }),
  enabled: t.Boolean() }, { additionalProperties: false });
export const setGateResponse = t.Object({ ...setGateInput.properties, epoch: t.String({ format: "uuid" }),
  mutations: t.Array(t.Union([t.Literal("update"), t.Literal("delete"), t.Literal("apply")])) });
