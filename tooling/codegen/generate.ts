// Generates CLI descriptors and schema graphs solely from the committed OpenAPI contract.
import { mkdir, readdir } from "node:fs/promises";
import { commands, stable, tools } from "./commands.ts";
const source: unknown = await Bun.file(new URL("../../contracts/openapi/openapi.json", import.meta.url)).json();
for (const { surface, artifacts } of [
  { surface: "cli", artifacts: commands(source) },
  { surface: "mcp", artifacts: { tools: tools(source) } },
]) {
  const directory = new URL(`../../packages/${surface}/generated/`, import.meta.url);
  if (!process.argv.includes("--check")) await mkdir(directory, { recursive: true });
  const expectedFiles = Object.keys(artifacts).map((name) => `${name}.json`);
  if ((await readdir(directory)).some((name) => !expectedFiles.includes(name))) throw new Error(`Unexpected ${surface} generated file`);
  for (const [name, value] of Object.entries(artifacts)) {
    const target = new URL(`${name}.json`, directory), expected = stable(value);
    if (process.argv.includes("--check")) {
      if (!await Bun.file(target).exists() || await Bun.file(target).text() !== expected) throw new Error(`${surface} drift: ${name}; run bun run codegen`);
    } else await Bun.write(target, expected);
  }
}
