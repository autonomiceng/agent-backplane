import { describe, expect, test } from "bun:test";
import { ConfigError, readConfig } from "./config.ts";
import { credentials } from "../../../packages/cli/runtime/credentials.ts";

describe("readConfig", () => {
  test("refuses to start without a database url or auth secret", () => {
    expect(() => readConfig({})).toThrow(ConfigError);
    expect(() => readConfig({ BP_DATABASE_URL: "postgres://x" })).toThrow(ConfigError);
  });

  test("rejects a server admin URL while applying runtime defaults", () => {
    const config = readConfig({ BP_DATABASE_URL: "postgres://x", BP_AUTH_SECRET: "test-secret" });
    expect(config).toEqual({ databaseUrl: "postgres://x", port: 3000, dataDir: "./data",
      authSecret: "test-secret", publicOrigin: "http://localhost:3000", signup: "closed", insecureOrigin: true });
    expect(() => readConfig({ BP_DATABASE_URL: "postgres://x", BP_ADMIN_DATABASE_URL: "postgres://admin", BP_AUTH_SECRET: "test-secret" })).toThrow("BP_ADMIN_DATABASE_URL is forbidden");
    expect(readConfig({ BP_DATABASE_URL: "postgres://x", BP_AUTH_SECRET: "test-secret", BP_PORT: "4000" }).publicOrigin).toBe("http://localhost:4000");
    expect(readConfig({ BP_DATABASE_URL: "postgres://x", BP_AUTH_SECRET: "test-secret", BP_AUTH_URL: "https://backplane.example" }).publicOrigin).toBe("https://backplane.example");
    for (const publicUrl of ["http://2130706433", "http://0177.0.0.1", "http://0x7f000001", "https://127.1",
      "http://localhost:", "https://[::1]:", "http://%31%32%37.0.0.1"]) {
      const env = { BP_DATABASE_URL: "postgres://x", BP_AUTH_SECRET: "test-secret", BP_PUBLIC_URL: publicUrl };
      expect(() => readConfig(env)).toThrow(ConfigError);
      expect(() => credentials(env, "none", undefined)).toThrow("BP_URL_invalid");
    }
    for (const publicUrl of ["http://127.42.0.1:3000", "http://[::1]", "http://localhost"]) {
      expect(readConfig({ BP_DATABASE_URL: "postgres://x", BP_AUTH_SECRET: "test-secret", BP_PUBLIC_URL: publicUrl }).publicOrigin).toBe(publicUrl);
      expect(credentials({ BP_PUBLIC_URL: publicUrl }, "none", undefined).url).toBe(publicUrl);
    }
  });
});
