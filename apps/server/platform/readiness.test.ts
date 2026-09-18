import { describe, expect, test } from "bun:test";
import { REQUIRED_PGMQ_VERSION, decideReadiness, type ClusterFacts } from "./readiness.ts";

const healthy: ClusterFacts = {
  restoreGate: false,
  postgresMajor: 18,
  runtimeRoleName: "bp_server",
  runtimeRoleIsSuperuser: false,
  maxPreparedTransactions: 0,
  auditFunctions: [
    { name: "bind_context", secdef: true, owner: "bp_audit" },
    { name: "emit", secdef: true, owner: "bp_audit" },
  ],
  schemas: ["control", "queue", "audit", "pgmq"],
  pgmqFunctions: ["create", "send", "read", "archive", "delete", "set_vt", "pop"],
  pgmqVersion: "1.12.0",
  schemaVersion: 1,
};

describe("decideReadiness", () => {
  test("a healthy cluster is ready", () => {
    expect(decideReadiness(healthy, 1)).toMatchObject({ status: "ready", problems: [], pgmq: { compatible: true } });
  });

  test("a wrong postgres major is refused, with the version named", () => {
    const r = decideReadiness({ ...healthy, postgresMajor: 17 }, 1);
    expect(r.status).toBe("not_ready");
    expect(r.problems).toEqual(["postgres major 17, need 18"]);
  });

  test("a missing protected schema and a missing pgmq function are both reported", () => {
    const r = decideReadiness({ ...healthy, schemas: ["control", "queue"], pgmqFunctions: ["send"] }, 1);
    expect(r.problems).toContain("protected schema audit missing");
    expect(r.pgmq.compatible).toBe(false);
  });

  test("pgmq with the right functions but another version is incompatible", () => {
    const r = decideReadiness({ ...healthy, pgmqVersion: "1.11.0" }, 1);
    expect(r.problems).toEqual(["pgmq version 1.11.0, need 1.12.0"]);
    expect(r.pgmq.compatible).toBe(false);
  });

  test("a schema version behind the repository is refused", () => {
    expect(decideReadiness(healthy, 2).problems).toEqual(["schema version 1, need 2"]);
  });
});

describe("pinned versions", () => {
  test("readiness and infra/postgres/versions.env agree on the pgmq version", async () => {
    const env = await Bun.file(new URL("../../../infra/postgres/versions.env", import.meta.url)).text();
    expect(env).toContain(`PGMQ_VERSION=${REQUIRED_PGMQ_VERSION}`);
    const init = await Bun.file(new URL("../../../infra/init/core/002-pgmq-version.sql", import.meta.url)).text();
    expect(init).toContain(`VALUES ('${REQUIRED_PGMQ_VERSION}')`);
  });
});
