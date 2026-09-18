// Auth and enrollment health share the same closed-on-public-origin sign-up decision.
import { isLoopbackHost } from "../platform/config.ts";
export function signupPolicy(configured: "closed" | "open", publicOrigin: boolean): "closed" | "open" {
  return configured === "open" && !publicOrigin ? "open" : "closed";
}
export function isPublicOrigin(origin: string): boolean {
  return !isLoopbackHost(new URL(origin).hostname);
}
