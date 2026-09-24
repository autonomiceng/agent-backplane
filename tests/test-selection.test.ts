// The default suite leaves examples/ to `bun run test:examples`; CI runs both.
import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
async function run(...argv: string[]) {
  const child = Bun.spawn(argv, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: out + err };
}

test("bun run test selects no example test file while the same filter matches one without the default ignore", async () => {
  const unfiltered = await run("bun", "test", "key-segment");
  expect(unfiltered.code, unfiltered.output).toBe(0);
  expect(unfiltered.output).toMatch(/Ran \d+ tests? across 1 file/);
  const selected = await run("bun", "run", "test", "key-segment");
  expect(selected.code).not.toBe(0);
  expect(selected.output).not.toMatch(/Ran \d+ tests?/);
});
