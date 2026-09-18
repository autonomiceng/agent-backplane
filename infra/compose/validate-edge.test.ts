import { expect, test } from "bun:test";
import { validateEdge } from "./validate-edge.ts";

test("edge validation accepts supported HTTPS issuers only", () => {
  const env = { BP_PUBLIC_DOMAIN: "example.com", BP_SCHEME: "https" };
  expect(validateEdge({ ...env, BP_TLS_ISSUER: "acme" }).ca).toBe("acme");
  expect(validateEdge({ ...env, BP_TLS_ISSUER: "internal" }).ca).toBe("internal");
  expect(() => validateEdge({ ...env, BP_TLS_ISSUER: "none" })).toThrow();
  expect(() => validateEdge(env)).toThrow("BP_TLS_ISSUER");
});
