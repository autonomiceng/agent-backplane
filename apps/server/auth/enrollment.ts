// A startup-prepared capability resource; the database claim always overrides local delivery state.
import { isPublicOrigin, signupPolicy } from "./signup-policy.ts";
import { APIError } from "better-auth/api";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "../platform/config.ts";
import type { Pool } from "../platform/pool.ts";
import { capabilityPath, enrollmentFile, removeEnrollmentFile } from "./enrollment-file.ts";
import { EnrollmentFailure, enrollFirstUser, type EnrollmentBarrier } from "./enroll-first-user.ts";
import type { EnrollmentInput, enrollmentState } from "./enrollment-input.ts";
export type EnrollmentState = typeof enrollmentState.static;
export type EnrollmentObservation = { state: EnrollmentState; capabilityFile: string | null; observedAt: string | null };
export function createEnrollment(pool: Pool, config: Pick<Config, "dataDir" | "publicOrigin" | "authSecret" | "signup">, barrier?: EnrollmentBarrier) {
  const path = capabilityPath(config.dataDir), digest = (value: string) => createHash("sha256").update(value).digest();
  let hash: Buffer | undefined, failed = false;
  let observation: Promise<EnrollmentObservation> | undefined;
  const signup = { configured: config.signup, effective: signupPolicy(config.signup, isPublicOrigin(config.publicOrigin)) };
  const publicSignup = signup.configured === "open" && signup.effective === "closed";
  const facts = async (tx: import("bun").TransactionSQL): Promise<EnrollmentState> => {
    if ((await tx`SELECT singleton FROM control.enrollment`).length) return "claimed";
    return (await tx`SELECT id FROM control."user" LIMIT 1`).length ? "recovery_required" : "pending";
  };
  return {
    signup, publicSignup,
    async prepare(): Promise<void> {
      hash = undefined; failed = false;
      try {
        await pool.begin(async (tx) => {
          if ((await tx`SELECT id FROM control.organization WHERE id = 'default' FOR UPDATE`).length !== 1) throw new Error("organization_missing");
          if (await facts(tx) !== "pending") return;
          hash = digest(await enrollmentFile(path, async () => { await barrier?.("publication"); }));
        });
      } catch { failed = true; }
    },
    async observe(): Promise<EnrollmentObservation> {
      const unknown: EnrollmentObservation = { state: "unknown", capabilityFile: null, observedAt: null };
      try {
        observation ??= pool.begin(async (tx) => {
          await tx`SET LOCAL statement_timeout = '2s'`;
          const fact = await facts(tx);
          const state = fact !== "pending" ? fact : failed ? "recovery_required" : hash ? "pending" : "unknown";
          const [clock] = await tx<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          if (!clock) return unknown;
          return { state, capabilityFile: state === "pending" ? path : null, observedAt: clock.now.toISOString() };
        }).catch(() => unknown).finally(() => { observation = undefined; });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<EnrollmentObservation>(resolve => { timer = setTimeout(() => resolve(unknown), 2500); });
        return await Promise.race([observation, deadline]).finally(() => clearTimeout(timer));
      } catch { return unknown; }
    },
    async enroll(input: EnrollmentInput): Promise<{ status: 201; userId: string } | { status: 400 | 403 | 409 | 503; error: string }> {
      const valid = timingSafeEqual(digest(input.capability), hash ?? Buffer.alloc(32));
      const observed = await this.observe();
      if (observed.state === "claimed") return { status: 409, error: "enrollment_claimed" };
      if (observed.state !== "pending") return { status: 503, error: observed.state === "recovery_required" ? "enrollment_recovery_required" : "enrollment_unavailable" };
      if (!valid || !hash) return { status: 403, error: "enrollment_forbidden" };
      try {
        const userId = await enrollFirstUser(pool, config, input, hash, barrier);
        await barrier?.("after_commit");
        await removeEnrollmentFile(path).catch(() => {});
        return { status: 201, userId };
      } catch (error) {
        if (error instanceof APIError && ["INVALID_EMAIL", "INVALID_PASSWORD", "PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG"].includes(error.body?.code ?? "")) return { status: 400, error: "enrollment_input_invalid" };
        const reason = error instanceof EnrollmentFailure ? error.message : "enrollment_unavailable";
        return { status: reason === "enrollment_claimed" ? 409 : 503, error: reason };
      }
    },
  };
}
export type Enrollment = ReturnType<typeof createEnrollment>;
