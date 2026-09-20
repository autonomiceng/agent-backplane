import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compatibilityDate, configHash, sha256, type Manifest } from "./deployment-config.ts";
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

test("artifact evidence and control measurements leave deployment configHash unchanged", () => {
  const manifest: Omit<Manifest, "configHash"> = { version: 1, workspaceId: "w", functionName: "f", id: "d",
    bundle: "export default {}", bundleSha256: sha256("export default {}"), entryPoint: "default", compatibilityDate,
    outboundUrls: [], keyRef: { workspaceId: "w", principalId: "p" }, runtimeDigest: "workerd-binary-sha256:" + "a".repeat(64) };
  const withFacts = { ...manifest, artifact: { source: "host-declared", reference: "fixture:local", hostObservedImageId: "sha256:" + "b".repeat(64) }, controlHash: "c".repeat(64) };
  const withoutFacts = { ...manifest, artifact: { ...withFacts.artifact, hostObservedImageId: null }, controlHash: "d".repeat(64) };
  expect(configHash(withFacts)).toBe(configHash(manifest));
  expect(configHash(withoutFacts)).toBe(configHash(manifest));
});
