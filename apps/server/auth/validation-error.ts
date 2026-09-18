// Auth routes share a stable validation response that cannot echo rejected input.
import { status } from "elysia";

export function validationError({ code }: { code: string | number }) {
  if (code === "VALIDATION") return status(422, { error: "invalid_input" });
}
