// Enrollment is capability-authorized and returns no session or credential.
import { t } from "elysia";
export const enrollmentInput = t.Object({
  capability: t.String({ pattern: "^[a-f0-9]{64}$" }),
  email: t.String({ format: "email", maxLength: 254 }),
  password: t.String({ minLength: 8, maxLength: 128 }),
}, { additionalProperties: false });
export type EnrollmentInput = typeof enrollmentInput.static;
export const enrollmentResponse = t.Object({ status: t.Literal("enrolled"), userId: t.String() });
export const enrollmentError = t.Object({ error: t.String() });
export const enrollmentState = t.Union([t.Literal("pending"), t.Literal("claimed"), t.Literal("recovery_required"), t.Literal("unknown")]);
export const signupSchema = t.Object({ configured: t.Union([t.Literal("closed"), t.Literal("open")]), effective: t.Union([t.Literal("closed"), t.Literal("open")]) });
