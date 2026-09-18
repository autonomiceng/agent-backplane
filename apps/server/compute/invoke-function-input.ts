// Invocation contracts bound encoded input before Elysia validates its JSON shape.
import { t, status } from "elysia";
export const invocationLimit = 1048576;
export const invokeFunctionInput = t.Object({ input: t.Unknown(), timeoutMs: t.Optional(t.Integer({ minimum: 1 })) }, { additionalProperties: false });
export const invocationResponse = t.Object({ deploymentId: t.String(), runId: t.String(), status: t.Integer(), result: t.Unknown() });
export const invocationCodes = { run_required: 400, run_invalid: 400, unauthorized: 401, workspace_forbidden: 403,
  run_forbidden: 403, invocation_scope_forbidden: 403, function_not_found: 404, invocation_body_too_large: 413,
  invalid_input: 422, function_failed: 502, function_response_invalid: 502, function_response_too_large: 502,
  function_timeout: 504, compute_disabled: 503, compute_unavailable: 503, admission_unavailable: 503,
  restore_gated: 503, invocation_finalize_failed: 503 } as const;
export class InvocationError extends Error {
  constructor(readonly reason: keyof typeof invocationCodes) { super(reason); }
}
export async function readInvocationBytes(body: ReadableStream<Uint8Array> | null, reason: "invocation_body_too_large" | "function_response_too_large", signal?: AbortSignal): Promise<Buffer> {
  const reader = body?.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  let size = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > invocationLimit) throw new InvocationError(reason);
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { signal?.removeEventListener("abort", cancel); cancel(); }
}
export async function parseInvocationBody({ request }: { request: Request }): Promise<unknown> {
  try { return JSON.parse((await readInvocationBytes(request.body, "invocation_body_too_large")).toString("utf8")); }
  catch (error) { throw status(error instanceof InvocationError ? 413 : 422,
    { error: error instanceof InvocationError ? error.reason : "invalid_input" }); }
}
