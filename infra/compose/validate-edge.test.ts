import { expect, test } from "bun:test";
import { readConfig, resolvePublicOrigin } from "../../apps/server/platform/config.ts";
import { credentials } from "../../packages/cli/runtime/credentials.ts";
import { resolveAccess, validateEdge } from "./validate-edge.ts";

test("mode derivation keeps core HTTP and selects the configured standalone listeners", () => {
  expect(resolveAccess({ BP_ACCESS_MODE: "proxy", BP_PUBLIC_URL: "https://backplane.example.com", BP_PUBLIC_DOMAIN: "unused/domain", BP_BIND_HOST: "unused", BP_HTTP_PORT: "unused", BP_HTTPS_PORT: "unused" }).origin).toBe("https://backplane.example.com");
  expect(resolveAccess({})).toMatchObject({ mode: "local", origin: "http://localhost:3000" });
  expect(validateEdge({})).toMatchObject({ mode: "local", host: "backplane.localhost", origin: "http://localhost" });
  expect(validateEdge({ BP_PUBLIC_DOMAIN: "example.com", BP_HTTPS_PORT: "8443" }).origin).toBe("https://backplane.example.com:8443");
  expect(validateEdge({ BP_ACCESS_MODE: "public", BP_PUBLIC_DOMAIN: "example.com" }).origin).toBe("https://backplane.example.com");
  expect(() => validateEdge({ BP_ACCESS_MODE: "public", BP_PUBLIC_DOMAIN: "example.com", BP_PUBLIC_URL: "https://elsewhere.example" })).toThrow("must match");
});

test("one canonical origin survives multiple listener protocols and matching auth configuration", () => {
  const env = { BP_PUBLIC_URL: "HTTPS://LOCALHOST:8443/", BP_AUTH_URL: "https://localhost:8443", BP_HTTPS_PORT: "8443" };
  const access = validateEdge(env);
  expect(access.origin).toBe("https://localhost:8443");
  expect(credentials(env, "none", undefined).url).toBe(access.origin);
  expect(() => credentials({ BP_AUTH_URL: access.origin }, "none", undefined)).toThrow("BP_URL_required");
  expect(resolvePublicOrigin({ ...env, BP_PUBLIC_URL: access.origin }, "http://untrusted-host")).toBe(access.origin);
  expect(() => validateEdge({ ...env, BP_AUTH_URL: "http://localhost" })).toThrow("must match");
});

test("invalid and conflicting modes fail before deployment or server startup", () => {
  expect(() => resolveAccess({ BP_ACCESS_MODE: "internal" })).toThrow("BP_ACCESS_MODE");
  expect(() => resolveAccess({ BP_ACCESS_MODE: "" })).toThrow("BP_ACCESS_MODE");
  expect(() => validateEdge({ BP_ACCESS_MODE: "local", BP_TLS_ISSUER: "acme" })).toThrow("Use BP_ACCESS_MODE");
  expect(() => validateEdge({ BP_ACCESS_MODE: "public" })).toThrow("own domain");
  expect(() => validateEdge({ BP_HTTP_PORT: "443" })).toThrow("must differ");
  expect(() => validateEdge({ BP_HTTPS_PORT: "65536" })).toThrow("port");
  expect(() => validateEdge({ BP_PUBLIC_URL: "https://127.0.0.2" })).toThrow("local listener");
  expect(() => resolveAccess({ BP_ACCESS_MODE: "proxy" })).toThrow("BP_PUBLIC_URL");
  expect(() => validateEdge({ BP_ACCESS_MODE: "proxy", BP_PUBLIC_URL: "https://backplane.example.com" })).toThrow("omit --profile edge");
  expect(() => readConfig({ BP_ACCESS_MODE: "invalid" })).toThrow("BP_ACCESS_MODE");
  expect(() => readConfig({ BP_ACCESS_MODE: "public", BP_PUBLIC_URL: "http://localhost", BP_DATABASE_URL: "postgres://unused", BP_AUTH_SECRET: "a".repeat(32) })).toThrow("HTTPS");
});
