import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, appendFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readArtifactEvidence, readControlSurfaceHash, type ArtifactEvidence } from "./runtime-identity.ts";

test("Bun and POSIX shell agree on control identity; changing any mounted control file changes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-control-")), url = pathToFileURL(directory + "/");
  try {
    const names = ["loader.js", "config.capnp", "start.sh"];
    for (const name of names) await copyFile(new URL(`./workerd/${name}`, import.meta.url), join(directory, name));
    const original = await readControlSurfaceHash(url);
    const child = Bun.spawn(["sh", "-ec", 'cd "$1"; control=$(sha256sum loader.js config.capnp start.sh); printf "%s\\n" "$control" | sha256sum', "control", directory], { stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(out.split(" ")[0]).toBe(original);
    for (const name of names) {
      await appendFile(join(directory, name), "\n# changed control fixture\n");
      expect(await readControlSurfaceHash(url)).not.toBe(original);
      await copyFile(new URL(`./workerd/${name}`, import.meta.url), join(directory, name));
    }
    expect(await readControlSurfaceHash(url)).toBe(original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("private artifact facts accept explicit unknown image IDs and reject malformed or oversized declarations", () => {
  const artifact: ArtifactEvidence = { source: "host-declared", reference: "registry.example:5000/worker:local", hostObservedImageId: null };
  expect(readArtifactEvidence(JSON.stringify(artifact))).toEqual(artifact);
  const observed = { ...artifact, hostObservedImageId: "sha256:" + "a".repeat(64) };
  expect(readArtifactEvidence(JSON.stringify(observed))).toEqual(observed);
  for (const value of [null, "{", "x".repeat(1025), JSON.stringify({ ...artifact, token: "secret" }),
    JSON.stringify({ ...artifact, source: "measured" }), JSON.stringify({ ...artifact, hostObservedImageId: "local:tag" }),
    JSON.stringify({ ...artifact, reference: "https://user:secret@host/image" }), JSON.stringify({ ...artifact, reference: "bad\nvalue" })]) {
    expect(readArtifactEvidence(value)).toBeNull();
  }
});


test("entrypoint rejects malformed references before measuring or executing the binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-entrypoint-"));
  try {
    const probe = join(directory, "sha256sum");
    await Bun.write(probe, "#!/bin/sh\necho binary-probe-reached >&2\nexit 77\n");
    await chmod(probe, 0o700);
    for (const reference of ["", "https://host/image", "bad\nvalue", "bad value", "/image", "image/", "image:", "image@sha256:abc", `image@sha256:${"A".repeat(64)}`, `image@sha256:${"a".repeat(64)}@extra`, "x".repeat(513),
      "fixture:local", "registry.example:5000/path/image:local", `image@sha256:${"a".repeat(64)}`, `sha256:${"a".repeat(64)}`]) {
      const valid = ["fixture:local", "registry.example:5000/path/image:local", `image@sha256:${"a".repeat(64)}`, `sha256:${"a".repeat(64)}`].includes(reference);
      const child = Bun.spawn(["/bin/sh", new URL("./workerd/start.sh", import.meta.url).pathname], {
        env: { PATH: directory, BP_WORKERD_IMAGE: reference, BP_WORKERD_BINARY_SHA256: "a".repeat(64) }, stdout: "pipe", stderr: "pipe",
      });
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code).toBe(valid ? 77 : 1);
      expect(error.trim()).toBe(valid ? "binary-probe-reached" : "invalid BP_WORKERD_IMAGE reference");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
