// Root-run owner for the five engine scenarios. The sixth is scripts/storage-migration-drill.py.
import assert from "node:assert/strict";
const name = "bp-migration-test-" + crypto.randomUUID();
const image = "rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff";
const access = crypto.randomUUID(), secret = crypto.randomUUID() + crypto.randomUUID();
let container: string | undefined, volume: string | undefined;
async function docker(...args: string[]) {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", env: { ...Bun.env, RUSTFS_ACCESS_KEY: access, RUSTFS_SECRET_KEY: secret } });
  const timer = setTimeout(() => child.kill(), 120000);
  try {
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    assert.equal(code, 0, `owned migration fixture Docker ${args[0]} failed: ${err.trim().replaceAll(access, "[redacted]").replaceAll(secret, "[redacted]").slice(0, 2048)}`); return out.trim();
  } finally { clearTimeout(timer); }
}
try {
  await docker("pull", image);
  volume = await docker("volume", "create", "--label", "backplane.test-owner=" + name, name);
  container = await docker("create", "--name", name, "--label", "backplane.test-owner=" + name,
    "--mount", `type=volume,source=${volume},target=/data`, "--publish", "127.0.0.1::9000", "--memory", "2g",
    "--env", "RUSTFS_ACCESS_KEY", "--env", "RUSTFS_SECRET_KEY", "--env", "RUSTFS_ADDRESS=:9000",
    "--env", "RUSTFS_CONSOLE_ENABLE=false", "--env", "RUSTFS_OBS_LOG_DIRECTORY=", image, "/data");
  await docker("start", container);
  const endpoint = "http://" + await docker("port", container, "9000"), deadline = performance.now() + 60000;
  for (;;) {
    const response = await fetch(endpoint + "/health/ready", { signal: AbortSignal.timeout(1000) }).catch(() => null);
    await response?.body?.cancel(); if (response?.ok) break;
    assert(performance.now() < deadline, "owned RustFS readiness deadline exceeded"); await Bun.sleep(250);
  }
  const test = Bun.spawn(["bun", "run", "test", "apps/server/blobs/storage-migration.test.ts"], { stdout: "inherit", stderr: "inherit",
    env: { ...Bun.env, BP_MIGRATION_TEST_ENDPOINT: endpoint, BP_MIGRATION_TEST_ACCESS: access, BP_MIGRATION_TEST_SECRET: secret } });
  const timeout = setTimeout(() => test.kill(), 600000);
  try { assert.equal(await test.exited, 0, "migration engine scenarios failed"); }
  finally { clearTimeout(timeout); }
} finally {
  if (container) await docker("rm", "--force", container);
  if (volume) await docker("volume", "rm", volume);
}
