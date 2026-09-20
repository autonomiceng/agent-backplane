import { expect, test } from "bun:test";
import { mkdtemp, copyFile, appendFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { controlUnchanged, readPort } from "./child-process.ts";
import { readControlSurfaceHash } from "../runtime-identity.ts";

test("child control validation refuses malformed or drifted inputs and a lost reap cannot leave its parent alive", async () => {
  const stream = (text: string) => new Blob([text]).stream();
  const signal = AbortSignal.timeout(1000);
  expect(await readPort(stream('{"event":"listen","socket":"control","port":32145}\nforged later output\n'), signal)).toBe(32145);
  await expect(readPort(stream('{"event":"listen","socket":"other","port":32145}\n'), signal)).rejects.toThrow("compute_unavailable");
  await expect(readPort(stream(" ".repeat(256) + '\n'), signal)).rejects.toThrow("compute_unavailable");
  const directory = await mkdtemp(join(tmpdir(), "bp-child-controls-"));
  try {
    for (const name of ["loader.js", "config.capnp", "start.sh", "supervisor.ts", "child-process.ts"]) {
      await copyFile(new URL(name, import.meta.url), join(directory, name));
    }
    const hash = await readControlSurfaceHash();
    expect(await controlUnchanged(join(directory, "config.capnp"), hash)).toBe(true);
    await appendFile(join(directory, "supervisor.ts"), "\n// changed mounted control\n");
    expect(await controlUnchanged(join(directory, "config.capnp"), hash)).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
  const module = new URL("./child-process.ts", import.meta.url).href;
  const parent = Bun.spawn([process.execPath, "-e", `import {killAndReap} from ${JSON.stringify(module)};
    const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore'});
    console.log(child.pid);
    await killAndReap({kill:()=>child.kill('SIGKILL'),exited:new Promise(()=>{})},()=>process.exit(23));`], { stdout: "pipe", stderr: "inherit" });
  const timer = setTimeout(() => parent.kill("SIGKILL"), 4000);
  try {
    const pid = Number(await new Response(parent.stdout).text());
    expect(await parent.exited).toBe(23);
    expect(pid).toBeGreaterThan(0); expect(existsSync(`/proc/${pid}`)).toBe(false);
  } finally { clearTimeout(timer); }
});
