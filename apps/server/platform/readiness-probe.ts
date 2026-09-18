import type { Enrollment } from "../auth/enrollment.ts";
import type { Pool } from "./pool.ts";
import { type ClusterFacts, type Readiness, decideReadiness, unavailable } from "./readiness.ts";

// Gathers cluster facts on one borrowed connection with a short deadline, so a locked ledger or a stalled
// cluster costs one connection for two seconds, never the pool. Any failure is reported, never thrown.
const PROBE_TIMEOUT_MS = 2000;

export async function probeReadiness(pool: Pool, expectedSchemaVersion: number, enrollment?: Enrollment): Promise<Readiness> {
  try {
    const facts = await clusterFacts(pool);
    if (enrollment) { facts.enrollment = (await enrollment.observe()).state; facts.signup = enrollment.signup; facts.publicSignup = enrollment.publicSignup; }
    return decideReadiness(facts, expectedSchemaVersion);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

function clusterFacts(pool: Pool): Promise<ClusterFacts> {
  return pool.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${PROBE_TIMEOUT_MS}; SET LOCAL lock_timeout = ${PROBE_TIMEOUT_MS}`);
    const [version] = await tx`SELECT current_setting('server_version_num')::int / 10000 AS major,
      current_setting('max_prepared_transactions')::int AS max_prepared_transactions`;
    const [role] = await tx`SELECT session_user AS name, runtime.rolsuper OR EXISTS (
      SELECT 1 FROM pg_roles r WHERE r.rolsuper AND pg_has_role(session_user, r.oid, 'MEMBER')
    ) AS rolsuper FROM pg_roles runtime WHERE runtime.rolname = session_user`;
    const schemas = await tx`SELECT nspname FROM pg_namespace`;
    const fns = await tx`
      SELECT DISTINCT n.nspname, p.proname, p.prosecdef, r.rolname FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
      WHERE n.nspname IN ('pgmq', 'audit')`;
    const [hasInstall] = await tx`SELECT to_regclass('pgmq.backplane_install') IS NOT NULL AS ok`;
    const pgmqVersion = hasInstall?.ok
      ? ((await tx`SELECT version FROM pgmq.backplane_install ORDER BY installed_at DESC LIMIT 1`)[0]?.version ?? null)
      : null;
    const [hasLedger] = await tx`SELECT to_regclass('control.schema_version') IS NOT NULL AS ok`;
    const schemaVersion = hasLedger?.ok ? ((await tx`SELECT max(version)::int AS v FROM control.schema_version`)[0]?.v ?? null) : null;
    const [hasGate] = await tx`SELECT to_regclass('control.restore_gate') IS NOT NULL AS ok`;
    // A missing gate relation or singleton is a readiness problem, never an open gate.
    const gate = hasGate?.ok ? (await tx`SELECT active FROM control.restore_gate WHERE singleton`)[0] : undefined;
    const restoreGate: boolean | "missing" = gate ? Boolean(gate.active) : "missing";
    return {
      restoreGate,
      postgresMajor: version?.major ?? 0,
      runtimeRoleName: role?.name ?? "",
      runtimeRoleIsSuperuser: role?.rolsuper ?? false,
      maxPreparedTransactions: version?.max_prepared_transactions ?? 0,
      auditFunctions: fns.filter((r: { nspname: string }) => r.nspname === "audit")
        .map((r: { proname: string; prosecdef: boolean; rolname: string }) => ({ name: r.proname, secdef: r.prosecdef, owner: r.rolname })),
      schemas: schemas.map((r: { nspname: string }) => r.nspname),
      pgmqFunctions: fns.filter((r: { nspname: string }) => r.nspname === "pgmq").map((r: { proname: string }) => r.proname),
      pgmqVersion,
      schemaVersion,
    };
  });
}
