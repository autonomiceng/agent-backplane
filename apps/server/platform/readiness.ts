// The readiness decision, pure. The probe gathers facts; this says whether the server may serve.

export const REQUIRED_POSTGRES_MAJOR = 18;
export const REQUIRED_PGMQ_VERSION = "1.12.0";
export const PROTECTED_SCHEMAS = ["control", "queue", "audit"] as const;
export const REQUIRED_PGMQ_FUNCTIONS = ["create", "send", "read", "archive", "delete", "set_vt"] as const;
export const REQUIRED_AUDIT_FUNCTIONS = ["bind_context", "emit"] as const;

import type { EnrollmentState } from "../auth/enrollment.ts";
export type ClusterFacts = {
  enrollment?: EnrollmentState;
  signup?: { configured: "closed" | "open"; effective: "closed" | "open" };
  publicSignup?: boolean;
  restoreGate: boolean | "missing";
  postgresMajor: number;
  runtimeRoleName: string;
  runtimeRoleIsSuperuser: boolean;
  maxPreparedTransactions: number;
  auditFunctions: { name: string; secdef: boolean; owner: string }[];
  schemas: string[];
  pgmqFunctions: string[];
  pgmqVersion: string | null;
  schemaVersion: number | null;
};

export type Readiness = {
  enrollment: { state: EnrollmentState };
  signup: { configured: "closed" | "open"; effective: "closed" | "open" };
  restoreGate: boolean;
  status: "ready" | "not_ready";
  problems: string[];
  postgres: { major: number };
  runtimeRole: { name: string; superuser: boolean };
  pgmq: { compatible: boolean; version: string | null };
  schemaVersion: number | null;
};

export function decideReadiness(facts: ClusterFacts, expectedSchemaVersion: number): Readiness {
  const problems: string[] = [];
  if (facts.enrollment === "recovery_required" || facts.enrollment === "unknown") problems.push(`enrollment_${facts.enrollment}`);
  if (facts.publicSignup) problems.push("signup_open_public_origin");
  if (facts.runtimeRoleIsSuperuser) problems.push("runtime role is superuser");
  if (facts.maxPreparedTransactions !== 0) problems.push("max_prepared_transactions must be 0");
  for (const name of REQUIRED_AUDIT_FUNCTIONS) {
    const functions = facts.auditFunctions.filter((f) => f.name === name);
    if (!functions.length) problems.push(`audit function ${name} missing`);
    else if (functions.some((f) => !f.secdef || f.owner !== "bp_audit")) {
      problems.push(`audit function ${name} not a bp_audit definer`);
    }
  }
  if (facts.postgresMajor !== REQUIRED_POSTGRES_MAJOR) {
    problems.push(`postgres major ${facts.postgresMajor}, need ${REQUIRED_POSTGRES_MAJOR}`);
  }
  for (const s of PROTECTED_SCHEMAS) {
    if (!facts.schemas.includes(s)) problems.push(`protected schema ${s} missing`);
  }
  const missingPgmq = REQUIRED_PGMQ_FUNCTIONS.filter((f) => !facts.pgmqFunctions.includes(f));
  if (missingPgmq.length) problems.push(`pgmq functions missing: ${missingPgmq.join(", ")}`);
  if (facts.pgmqVersion !== REQUIRED_PGMQ_VERSION) {
    problems.push(`pgmq version ${facts.pgmqVersion ?? "none"}, need ${REQUIRED_PGMQ_VERSION}`);
  }
  if (facts.schemaVersion !== expectedSchemaVersion) {
    problems.push(`schema version ${facts.schemaVersion ?? "none"}, need ${expectedSchemaVersion}`);
  }
  const pgmqCompatible = missingPgmq.length === 0 && facts.pgmqVersion === REQUIRED_PGMQ_VERSION;
  if (facts.restoreGate === "missing") problems.push("control.restore_gate missing");
  const restoreGate = facts.restoreGate !== false;
  return {
    enrollment: { state: facts.enrollment ?? "unknown" }, signup: facts.signup ?? { configured: "closed", effective: "closed" },
    restoreGate,
    status: problems.length || restoreGate ? "not_ready" : "ready",
    problems,
    postgres: { major: facts.postgresMajor },
    runtimeRole: { name: facts.runtimeRoleName, superuser: facts.runtimeRoleIsSuperuser },
    pgmq: { compatible: pgmqCompatible, version: facts.pgmqVersion },
    schemaVersion: facts.schemaVersion,
  };
}

export function originDiagnostic(readiness: Readiness, insecureOrigin: boolean): Readiness {
  return insecureOrigin ? { ...readiness, problems: [...readiness.problems, "insecure_origin"] } : readiness;
}

export function unavailable(reason: string): Readiness {
  return {
    enrollment: { state: "unknown" }, signup: { configured: "closed", effective: "closed" },
    status: "not_ready",
    restoreGate: true,
    problems: [`database unavailable: ${reason}`],
    postgres: { major: 0 },
    runtimeRole: { name: "", superuser: false },
    pgmq: { compatible: false, version: null },
    schemaVersion: null,
  };
}
