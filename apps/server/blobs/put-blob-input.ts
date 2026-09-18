// Upload query, checksum header, and returned metadata contract.
import { t } from "elysia";
export const blobKey = t.String({ maxLength: 256, pattern: "^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}(/[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}){0,3}$" });
export const blobResponse = t.Object({ workspace_id: t.String(), id: t.String(), key: t.String(), size: t.Integer(), sha256: t.String(),
  content_type: t.String(), principal_id: t.String(), run_id: t.String(), created_at: t.String(), expires_at: t.String() });
export const putBlobQuery = t.Object({ key: blobKey });
export const putBlobHeaders = t.Object({ "x-backplane-sha256": t.Optional(t.String({ pattern: "^[0-9a-f]{64}$" })) });
