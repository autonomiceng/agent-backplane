// The unauthenticated HTTP boundary bounds and validates input before capability authorization.
import { Elysia } from "elysia";
import type { Enrollment } from "./enrollment.ts";
import { enrollmentError, enrollmentInput, enrollmentResponse } from "./enrollment-input.ts";
class EnrollmentBodyLimit extends Error {}
export function enrollmentRoute(enrollment: Enrollment, authUrl: string) {
  return new Elysia({ name: "enrollment", normalize: false }).post("/api/v1/enrollment", async ({ body, status }) => {
    const result = await enrollment.enroll(body);
    return result.status === 201 ? status(201, { status: "enrolled", userId: result.userId }) : status(result.status, { error: result.error });
  }, {
    beforeHandle({ request, status }) {
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== new URL(authUrl).origin) return status(403, { error: "origin_forbidden" });
    },
    async parse({ request, set }) {
      set.headers["cache-control"] = "no-store";
      if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new Error("json_required");
      if (Number(request.headers.get("content-length")) > 4096) throw new EnrollmentBodyLimit();
      const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 4096) { await reader.cancel(); throw new EnrollmentBodyLimit(); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString());
      // The parent app normalizes bodies, which would strip unknown keys instead of rejecting them.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
        || Object.keys(parsed).some((key) => !Object.hasOwn(enrollmentInput.properties, key))) throw new Error("unknown_property");
      return parsed;
    },
    body: enrollmentInput,
    response: { 201: enrollmentResponse, 400: enrollmentError, 403: enrollmentError, 409: enrollmentError, 413: enrollmentError, 503: enrollmentError },
    error({ error, code, status, set }) {
      set.headers["cache-control"] = "no-store";
      if (error instanceof EnrollmentBodyLimit || "cause" in error && error.cause instanceof EnrollmentBodyLimit) return status(413, { error: "enrollment_body_too_large" });
      return code === "VALIDATION" || code === "PARSE" ? status(400, { error: "enrollment_input_invalid" }) : status(503, { error: "enrollment_unavailable" });
    },
    detail: { operationId: "enrollFirstUser", tags: ["enrollment"], "x-backplane-auth": "none", "x-backplane-run": "none", security: [] },
  });
}
