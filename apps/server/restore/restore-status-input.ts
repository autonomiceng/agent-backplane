// Restore inventory is visible only to a Workspace's Users.
import { t } from "elysia";
export const restoreParams = t.Object({ workspaceId: t.String({ format: "uuid" }) });
export const restoreStatusResponse = t.Object({ active: t.Boolean(), epoch: t.Nullable(t.String()),
  generation: t.Nullable(t.String()), minimumHead: t.Nullable(t.String()), rotated: t.Boolean(), done: t.Boolean(),
  releasedBy: t.Nullable(t.String()), pending: t.Integer() });
export const restoreErrors = { 401: t.Object({ error: t.String() }), 403: t.Object({ error: t.String() }),
  409: t.Object({ error: t.String() }), 422: t.Object({ error: t.String() }), 503: t.Object({ error: t.String() }) };
