import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "retire-status-timer.sh");

async function run(home: string, bin: string, envFile: string) {
  const child = Bun.spawn(["sh", script, envFile], { stdout: "pipe", stderr: "pipe",
    env: { PATH: `${bin}:${Bun.env.PATH ?? "/usr/bin:/bin"}`, HOME: home, XDG_CONFIG_HOME: join(home, ".config") } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("the retire script passes shellcheck and removes the version 1 timer and records idempotently", async () => {
  const lint = Bun.spawn(["shellcheck", "--shell=sh", script], { stdout: "pipe", stderr: "pipe" });
  expect(await lint.exited, await new Response(lint.stdout).text()).toBe(0);
  const home = await mkdtemp(join(tmpdir(), "bp-retire-"));
  try {
    const bin = join(home, "bin"), units = join(home, ".config/systemd/user"), state = join(home, "state"), log = join(home, "systemctl.log");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`);
    await chmod(join(bin, "systemctl"), 0o755);
    await mkdir(units, { recursive: true });
    for (const unit of ["agent-backplane-status.timer", "agent-backplane-status.service", "other.service"]) await writeFile(join(units, unit), "[Unit]\n");
    await mkdir(join(state, "status"), { recursive: true });
    await mkdir(join(state, "console"), { recursive: true });
    await writeFile(join(state, "status/bootstrap.json"), "{}");
    await writeFile(join(state, "status/observer.lock"), "");
    await writeFile(join(state, "console/status.json"), "{}");
    const envFile = join(home, ".env");
    await writeFile(envFile, `BP_AUTH_SECRET='x'\nBP_STATUS_DIR='${state}'\n`);

    const first = await run(home, bin, envFile);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout.split("\n").filter(Boolean)).toEqual([
      "disabled and removed agent-backplane-status.timer", "disabled and removed agent-backplane-status.service",
      `removed ${state}/status/bootstrap.json`, `removed ${state}/status/observer.lock`, `removed ${state}/console/status.json`,
      `removed ${state}/status`, `removed ${state}/console`,
    ]);
    expect(await readFile(log, "utf8")).toBe("--user disable --now agent-backplane-status.timer agent-backplane-status.service\n--user daemon-reload\n");
    expect(await Bun.file(join(units, "other.service")).exists()).toBe(true);
    expect(await Bun.file(join(units, "agent-backplane-status.timer")).exists()).toBe(false);

    // A partial pair names only the existing unit; a second run finds nothing and changes nothing.
    await writeFile(join(units, "agent-backplane-status.service"), "[Unit]\n");
    const partial = await run(home, bin, envFile);
    expect(partial.code, partial.stderr).toBe(0);
    expect(partial.stdout.trim()).toBe("disabled and removed agent-backplane-status.service");
    const again = await run(home, bin, envFile);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout.trim()).toBe(`no agent-backplane-status units in ${units}`);
    expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toHaveLength(4);
    const missing = await run(home, bin, join(home, "absent.env"));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("cannot read env file");
  } finally { await rm(home, { recursive: true, force: true }); }
});
