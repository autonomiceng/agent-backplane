// Compute contracts expose metadata only; bundles remain immutable deployment artifacts.
import { status, t } from "elysia";
export const functionParams = t.Object({ workspaceId: t.String({ format: "uuid" }), name: t.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }) });
export const deploymentParams = t.Object({ ...functionParams.properties, id: t.String({ format: "uuid" }) });
export const deploymentResponse = t.Object({
  workspaceId: t.String(), functionName: t.String(), id: t.String(), bundleSha256: t.String(), size: t.Integer(),
  entryPoint: t.Literal("default"), compatibilityDate: t.String(), outboundUrls: t.Array(t.String()),
  configHash: t.String(), runtimeDigest: t.String(), principalId: t.String(), runId: t.String(), createdAt: t.String(),
  status: t.Union([t.Literal("registered"), t.Literal("active"), t.Literal("retired")]),
});
const failure = t.Object({ error: t.String() });
export const computeFailures = { 400: failure, 401: failure, 403: failure, 404: failure, 408: failure,
  409: failure, 413: failure, 422: failure, 429: failure, 503: failure };
export async function parseComputeBody({ request }: { request: Request }): Promise<unknown> {
  if (!request.body) return;
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 6 * 4194304 + 65536) { await reader.cancel(); throw status(413, { error: "bundle_too_large" }); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw status(422, { error: "invalid_input" }); }
}
export function computeValidation({ code }: { code: string | number }) {
  if (code === "VALIDATION" || code === "PARSE") return status(422, { error: "invalid_input" });
}
