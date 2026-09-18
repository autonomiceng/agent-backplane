import { createHash, timingSafeEqual } from "node:crypto";
import type { Enrollment } from "../auth/enrollment.ts";
import { enrollmentState, signupSchema } from "../auth/enrollment-input.ts";
import { Elysia, t } from "elysia";
import type { Pool } from "./pool.ts";
import { probeReadiness } from "./readiness-probe.ts";
import { originDiagnostic } from "./readiness.ts";

const readinessSchema = t.Object({
  enrollment: t.Object({ state: enrollmentState }), signup: signupSchema,
  status: t.Union([t.Literal("ready"), t.Literal("not_ready")]),
  problems: t.Array(t.String()),
  restoreGate: t.Boolean(),
  runtimeRole: t.Object({ name: t.String(), superuser: t.Boolean() }),
  postgres: t.Object({ major: t.Integer() }),
  pgmq: t.Object({ compatible: t.Boolean(), version: t.Nullable(t.String()) }),
  schemaVersion: t.Nullable(t.Integer()),
});

// GET /health/ready answers 200 when the server may serve and 503 with the reasons when it may not.
export function healthRoute(pool: Pool, expectedSchemaVersion: number, enrollment: Enrollment, insecureOrigin = false, token?: string) {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  // The public form: enrollment state (the CLI bootstrap polls it before any credential exists), status and problem codes.
  const publicSchema = t.Pick(readinessSchema, ["enrollment", "status", "problems"]);
  const responseSchema = t.Union([readinessSchema, publicSchema]);
  return new Elysia({ name: "health" }).get(
    "/health/ready",
    async ({ set, request }) => {
      set.headers["cache-control"] = "no-store";
      const readiness = originDiagnostic(await probeReadiness(pool, expectedSchemaVersion, enrollment), insecureOrigin);
      if (readiness.status !== "ready") set.status = 503;
      const supplied = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1] ?? "";
      if (token && timingSafeEqual(hash(token), hash(supplied))) return readiness;
      const problems = readiness.problems.map(problem => {
        if (/^[a-z_]+$/.test(problem)) return problem;
        if (problem.startsWith("database unavailable:")) return "database_unavailable";
        if (problem.startsWith("runtime role")) return "runtime_role_invalid";
        if (problem.startsWith("max_prepared_transactions")) return "prepared_transactions_enabled";
        if (problem.startsWith("audit function")) return "audit_function_invalid";
        if (problem.startsWith("postgres major")) return "postgres_version_incompatible";
        if (problem.startsWith("protected schema")) return "protected_schema_missing";
        if (problem.startsWith("pgmq")) return "pgmq_incompatible";
        if (problem.startsWith("schema version")) return "schema_version_incompatible";
        return "restore_gate_unavailable";
      });
      if (readiness.restoreGate && !problems.includes("database_unavailable")) problems.push("restore_gated");
      return { enrollment: { state: readiness.enrollment.state }, status: readiness.status, problems: [...new Set(problems)] };
    },
    { response: { 200: responseSchema, 503: responseSchema }, detail: { "x-backplane-auth": "none", "x-backplane-run": "none", operationId: "healthReady", tags: ["health"] } },
  );
}
