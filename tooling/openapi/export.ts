// Fresh-process export keeps TypeBox recursive schema identifiers deterministic.
import { mkdir } from "node:fs/promises";
import { document } from "./document.ts";
const target = new URL("../../contracts/openapi/openapi.json", import.meta.url);
const expected = await document();
if (process.argv.includes("--check")) {
  if (!await Bun.file(target).exists() || await Bun.file(target).text() !== expected) throw new Error("OpenAPI drift: run bun run openapi:export");
} else {
  await mkdir(new URL(".", target), { recursive: true });
  await Bun.write(target, expected);
}
