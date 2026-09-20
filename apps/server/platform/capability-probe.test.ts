import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { adoptionFixture, initialization } from "../blobs/testing/storage-adoption-fixture.ts";
import { storeMarker } from "../blobs/storage-binding.ts";
import { createComputeLauncher } from "../compute/compute-launcher.ts";
import { readControlSurfaceHash } from "../compute/runtime-identity.ts";
import { createPool } from "./pool.ts";
import { capabilityProbe } from "./capability-probe.ts";

// Private binding initialization is the offline operator path; probes never create Workspace data.
test("Files drops cached success when its marker disappears or its current binding changes", async () => {
  const f = await adoptionFixture(), pool = createPool(f.url);
  try {
    await f.operate(initialization);
    const sample = capabilityProbe(pool, f.store), markerPath = join(f.dataDir, "blobs", storeMarker);
    const marker = await f.store.readMarker(), first = await sample();
    expect(first.files).toMatchObject({ state: "healthy", backend: "filesystem" });
    expect(await sample()).toEqual(first);
    await rm(markerPath);
    await Bun.sleep(5050);
    const missing = await sample();
    expect(missing.files).toMatchObject({ state: "unavailable", backend: null });
    expect(missing.files.observedAt).not.toBe(first.files.observedAt);
    await writeFile(markerPath, "foreign marker", { mode: 0o600 });
    expect((await capabilityProbe(pool, f.store)()).files.state).toBe("unavailable");
    await writeFile(markerPath, marker);
    await f.admin`UPDATE control.blob_storage_binding SET phase='verifying'`;
    expect((await capabilityProbe(pool, f.store)()).files.state).toBe("unavailable");
    await f.admin`UPDATE control.blob_storage_binding SET phase='ready',backend='s3'`;
    expect((await capabilityProbe(pool, f.store)()).files.state).toBe("unavailable");
    expect((await capabilityProbe(pool)()).files).toEqual({ state: "unknown", observedAt: null, backend: null });
  } finally { await pool.close(); await f.close(); }
}, 20000);

test("Functions distinguishes disabled and unreachable from a fresh compatible identity", async () => {
  const runtimeDigest = "workerd-binary-sha256:" + "a".repeat(64), control = await readControlSurfaceHash();
  let compatible = true;
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 204, headers: {
    "x-backplane-runtime": runtimeDigest, "x-backplane-control": compatible ? control : "b".repeat(64),
    "x-backplane-artifact": JSON.stringify({ source: "host-declared", reference: "private-image:local", hostObservedImageId: null }),
  } }) });
  // This scenario does not open a database connection; only Functions is configured.
  const pool = createPool("postgres://localhost/unused");
  try {
    const launcher = createComputeLauncher({ url: server.url.href, token: "private-token", runtimeDigest });
    expect((await capabilityProbe(pool)()).functions).toEqual({ state: "disabled", observedAt: null, backend: null });
    const sample = capabilityProbe(pool, undefined, launcher), first = await sample();
    expect(first.functions).toEqual({ state: "healthy", observedAt: expect.any(String), backend: "workerd" });
    compatible = false;
    await Bun.sleep(5050);
    expect((await sample()).functions).toEqual({ state: "unavailable", observedAt: expect.any(String), backend: null });
    await server.stop(true);
    expect((await capabilityProbe(pool, undefined, launcher)()).functions.state).toBe("unavailable");
  } finally { await server.stop(true); await pool.close(); }
}, 15000);

test("Concurrent stalled probes keep one I/O flight past deadline and never project private errors", async () => {
  const f = await adoptionFixture(), pool = createPool(f.url), pending = Promise.withResolvers<Uint8Array | null>();
  let active = 0, fail = false, signal: AbortSignal | undefined;
  try {
    await f.operate(initialization);
    const sample = capabilityProbe(pool, { backend: "filesystem", markerOrAbsent(abort) {
      active++; signal = abort;
      return fail ? Promise.reject(new Error("private-token /private/path")) : pending.promise;
    } }, { async verify() { throw new Error("private-token http://private/bucket"); } });
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: 8 }, () => sample()));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(active).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(results.every(result => result.files.state === "unavailable" && result.functions.state === "unavailable")).toBe(true);
    const original = results[0]?.files;
    if (!original) throw new Error("missing concurrent result");
    expect(original).toEqual({ state: "unavailable", observedAt: expect.any(String), backend: null });
    expect(Date.parse(original.observedAt ?? "")).toBeLessThan(Date.now() - 1500);
    await Bun.sleep(3100);
    expect((await sample()).files).toEqual(original);
    expect(active).toBe(1);
    fail = true;
    pending.resolve(await f.store.readMarker());
    await Bun.sleep(0);
    const failed = await sample();
    expect(failed.files.state).toBe("unavailable");
    expect(failed.files.observedAt).not.toBe(original.observedAt);
    expect(JSON.stringify(failed)).not.toMatch(/private|bucket|token|path|error/);
  } finally { pending.resolve(null); await pool.close(); await f.close(); }
}, 20000);
