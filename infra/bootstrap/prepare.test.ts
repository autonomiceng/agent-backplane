import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepare, type Runner } from "./prepare.ts";

test("prepare launches root compose without the core profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-prepare-compose-"));
  const calls: string[][] = [];
  const runner: Runner = async args => {
    calls.push(args);
    if (args[0] === "context") return "unix:///var/run/docker.sock";
    if (args[0] === "volume") return "";
    if (args.some(arg => arg.includes("curl"))) return JSON.stringify({ enrollment: { state: "claimed" } });
    return "";
  };
  try {
    await prepare([
      "--env-file", join(directory, ".env"),
      "--backup-dir", directory,
      "--public-url", "http://localhost:3000",
      "--capability-file", join(directory, "capability"),
    ], {}, runner);
    const root = resolve(import.meta.dir, "../..");
    const up = calls.find(args => args.at(-2) === "up" && args.at(-1) === "--wait");
    expect(up).toBeDefined();
    expect(up).toContain("--project-directory");
    expect(up).toContain(root);
    expect(up).toContain(resolve(root, "compose.yaml"));
    expect(up).not.toContain("core");
    expect(await readFile(join(directory, ".env"), "utf8")).toContain("BP_ACCESS_MODE='local'");
    expect(await readFile(join(directory, ".env"), "utf8")).toContain("BP_PUBLIC_URL='http://localhost:3000'");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
