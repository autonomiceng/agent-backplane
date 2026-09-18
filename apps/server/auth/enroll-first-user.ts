// The Organization lock serializes the Better Auth identity, claim, and membership transaction.
import { DrizzleQueryError, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "../../../db/internal/auth.ts";
import { enrollment } from "../../../db/internal/enrollment.ts";
import type { Config } from "../platform/config.ts";
import type { Pool } from "../platform/pool.ts";
import { createAuth } from "./auth.ts";
import type { EnrollmentInput } from "./enrollment-input.ts";
export type EnrollmentBarrier = (point: "publication" | "before_user" | "after_user" | "before_claim" | "after_claim" | "after_commit") => Promise<void>;
export class EnrollmentFailure extends Error {}
export async function enrollFirstUser(pool: Pool, config: Pick<Config, "publicOrigin" | "authSecret">, input: EnrollmentInput, hash: Buffer, barrier?: EnrollmentBarrier): Promise<string> {
  return drizzle({ client: pool, schema }).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    const organization = await tx.select().from(schema.organization).where(sql`id = 'default'`).for("update");
    if (organization.length !== 1) throw new EnrollmentFailure("enrollment_recovery_required");
    if ((await tx.select().from(enrollment)).length) throw new EnrollmentFailure("enrollment_claimed");
    if ((await tx.select({ id: schema.user.id }).from(schema.user).limit(1)).length) throw new EnrollmentFailure("enrollment_recovery_required");
    // bp_server cannot lock the gate row; only the definer's restore_gated exception means an armed restore.
    try { await tx.execute(sql`SELECT control.assert_restore_open()`); }
    catch (error) {
      const cause = error instanceof DrizzleQueryError ? error.cause : error;
      const gated = cause instanceof Error && "errno" in cause && cause.errno === "P0001" && cause.message === "restore_gated";
      throw new EnrollmentFailure(gated ? "restore_gate_active" : "enrollment_unavailable");
    }
    await barrier?.("before_user");
    const auth = createAuth(pool, config, tx, false, async () => { await barrier?.("after_user"); });
    const email = input.email.toLowerCase();
    const result = await auth.api.signUpEmail({ body: { email, password: input.password, name: email } });
    const identity = await tx.select({ id: schema.user.id }).from(schema.user).innerJoin(schema.account, sql`${schema.account.userId} = ${schema.user.id}`)
      .where(sql`${schema.user.id} = ${result.user.id} AND ${schema.user.email} = ${email} AND ${schema.account.providerId} = 'credential'
        AND ${schema.account.accountId} = ${result.user.id} AND ${schema.account.password} IS NOT NULL`);
    if (identity.length !== 1) throw new EnrollmentFailure("enrollment_unavailable");
    await barrier?.("before_claim");
    await tx.insert(enrollment).values({ userId: result.user.id, capabilityHash: hash });
    await barrier?.("after_claim");
    return result.user.id;
  });
}
