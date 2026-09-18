// Shared error response schemas keep all retention routes on the same contract.
import { t } from "elysia";
const error = t.Object({ error: t.String() });
export const retentionFailures = { 400: error, 401: error, 403: error, 404: error, 408: error, 410: error, 422: error, 503: error };
