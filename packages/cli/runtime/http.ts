// Buffered JSON HTTP requests preserve request bytes and never follow credential-bearing redirects.
import { CliError, type Credentials } from "./credentials.ts";
export function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export async function request(config: Credentials, path: string, method: string, body: string | Uint8Array | undefined, headers: Headers, runId?: string, signal?: AbortSignal, transport: typeof fetch = fetch) {
  const outgoing = new Headers(headers);
  if (outgoing.has("cookie")) outgoing.set("origin", config.url);
  if (config.key) outgoing.set("authorization", `Bearer ${config.key}`);
  if (runId) outgoing.set("x-backplane-run", runId);
  try {
    return await transport(`${config.url}${path}`, { method, headers: outgoing, redirect: "error", ...(body === undefined ? {} : { body: typeof body === "string" ? body : Buffer.from(body) }), ...(signal ? { signal } : {}) });
  } catch (error) {
    const cause = record(error) && record(error.cause) ? error.cause : error;
    // Only connection establishment and certificate verification codes prove that no body was sent.
    const unsent = record(cause) && typeof cause.code === "string" && ["ECONNREFUSED", "ConnectionRefused", "ENOTFOUND", "EAI_AGAIN", "DNSLookupFailed",
      "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER"].includes(cause.code);
    throw new CliError(unsent ? "transport_unsent" : "transport_failed", unsent ? 2 : 1);
  }
}
export async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new CliError("invalid_response", 1, response.status); }
}
export function failure(response: Response, value: unknown): void {
  if (!response.ok) throw new CliError(record(value) && typeof value.error === "string" ? value.error : "http_error", 1, response.status, value);
}
