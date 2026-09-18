// Filesystem-only regression for abandoned locks and live-owner exclusion.
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCache } from "./run-cache.ts";

test("an abandoned Run-cache lock blocks commands or a waiter steals a live owner's lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-run-lock-"));
  const config = { directory: join(directory, "runs"), url: "http://localhost", workspaceId: crypto.randomUUID(),
    key: `bp_${"a".repeat(24)}_${"b".repeat(64)}`, session: "lock-test" };
  const cache = runCache(config, Date.now);
  const run = () => ({ id: crypto.randomUUID(), workspaceId: config.workspaceId, principalId: crypto.randomUUID() });
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let holder: Promise<string> | undefined, waiter: Promise<string> | undefined;
  try {
    await cache.select(async () => run());
    const file = (await readdir(config.directory)).find((name) => name.endsWith(".json"));
    if (!file) throw new Error("cache file missing");
    const lock = join(config.directory, `${file}.lock`);
    const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
    await child.exited;
    await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, "owner"), JSON.stringify({ pid: child.pid, createdAt: Date.now() }), { mode: 0o600 });
    const recovered = run();
    expect(await cache.select(async () => recovered, undefined, true)).toBe(recovered.id);
    expect(await readdir(config.directory)).toEqual([file]);
    const first = run(), second = run();
    holder = cache.select(async () => { entered.resolve(); await release.promise; return first; }, undefined, true);
    await entered.promise;
    const owner = JSON.parse(await readFile(join(lock, "owner"), "utf8")) as { pid: number; createdAt: number };
    expect(owner.pid).toBe(process.pid);
    expect(owner.createdAt).toBeGreaterThan(0);
    let acquired = false;
    waiter = cache.select(async () => { acquired = true; return second; }, undefined, true);
    await Bun.sleep(50);
    expect(acquired).toBe(false);
    release.resolve();
    expect(await holder).toBe(first.id);
    expect(await waiter).toBe(second.id);
    expect(await cache.select(async () => run())).toBe(second.id);
    expect(await readdir(config.directory)).toEqual([file]);
  } finally {
    release.resolve();
    await Promise.allSettled([holder, waiter]);
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
