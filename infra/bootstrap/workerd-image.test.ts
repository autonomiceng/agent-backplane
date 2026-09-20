import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateRead } from "../../packages/cli/runtime/credential-file.ts";
import { defaultWorkerdBinary, defaultWorkerdImage, persistWorkerdEvidence, verifyWorkerdImage } from "./workerd-image.ts";
import type { Runner } from "./prepare.ts";

const imageId = "sha256:" + "c".repeat(64), entries = { BP_WORKERD_IMAGE: "local/workerd:experiment" };
const supervisorBinary = "a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c";
const hashes = `${defaultWorkerdBinary}  /usr/bin/workerd\n${supervisorBinary}  /usr/bin/bun\n`;
function dockerFixture() {
  const images = new Map([[entries.BP_WORKERD_IMAGE, imageId]]);
  const state = { inspectedImageId: imageId, builds: 0, architecture: "amd64", hashes, workerdVersion: "workerd 2026-09-18", bunVersion: "1.4.2", missingBun: false };
  const run: Runner = async args => {
    if (args[0] === "info") return state.architecture;
    if (args[0] === "build") {
      const context = resolve(import.meta.dir, "../compute/image");
      expect(args.at(-1)).toBe(context);
      expect(args[args.indexOf("--file") + 1]).toBe(join(context, "Dockerfile"));
      expect(args[args.indexOf("--platform") + 1]).toBe("linux/amd64");
      expect(args[args.indexOf("--tag") + 1]).toBe(defaultWorkerdImage);
      images.set(defaultWorkerdImage, imageId); state.builds++;
      return "";
    }
    if (args[0] === "image") {
      const id = images.get(args.at(-1) ?? "");
      if (!id) throw Error("image absent locally");
      state.inspectedImageId = id;
      return `${id} ${state.architecture}`;
    }
    if (args[0] !== "run") throw Error("unexpected Docker command");
    const entrypoint = args.indexOf("--entrypoint"), id = args[entrypoint + 2];
    if (id !== state.inspectedImageId) throw Error("unverified launch image");
    expect(args[args.indexOf("--pull") + 1]).toBe("never");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    if (state.missingBun) throw Error("missing executable");
    if (args[entrypoint + 1] === "sha256sum") {
      expect(args.slice(entrypoint + 3)).toEqual(["/usr/bin/workerd", "/usr/bin/bun"]);
      return state.hashes;
    }
    if (args.at(-1) !== "--version") throw Error("unexpected executable arguments");
    return args[entrypoint + 1] === "/usr/bin/workerd" ? state.workerdVersion : state.bunVersion;
  };
  return { images, state, run };
}

test("missing and blank overrides build the pinned default independently of a server override; arm64 refuses", async () => {
  const { images, state, run } = dockerFixture();
  const settings = { BP_SERVER_IMAGE: "server:operator" };
  expect(images.has(defaultWorkerdImage)).toBe(false);
  expect((await verifyWorkerdImage(settings, {}, run)).reference).toBe(defaultWorkerdImage);
  expect((await verifyWorkerdImage({ ...settings, BP_WORKERD_IMAGE: " \t " }, {}, run)).imageId).toBe(imageId);
  expect(state.builds).toBe(2);
  expect(settings).toEqual({ BP_SERVER_IMAGE: "server:operator" });
  state.architecture = "arm64";
  await expect(verifyWorkerdImage({}, {}, run)).rejects.toMatchObject({ error: "workerd_default_architecture_unqualified" });
  expect(state.builds).toBe(2);
});

test("explicit local overrides are verified without rebuilding or pulling even when unavailable", async () => {
  const { images, state, run } = dockerFixture();
  const settings = { ...entries, BP_SERVER_IMAGE: "server:operator" }, before = { ...settings };
  expect(await verifyWorkerdImage(settings, {}, run)).toMatchObject({ reference: entries.BP_WORKERD_IMAGE, imageId,
    binarySha256: defaultWorkerdBinary, supervisorBinarySha256: supervisorBinary, supervisorVersion: "1.4.2" });
  images.delete(entries.BP_WORKERD_IMAGE);
  await expect(verifyWorkerdImage(settings, {}, run)).rejects.toThrow("image absent locally");
  expect(state.builds).toBe(0);
  expect(settings).toEqual(before);
});

test("invalid identity, missing supervisor and incompatible executables refuse launch", async () => {
  const { state, run } = dockerFixture();
  const unused: Runner = async () => { throw Error("must not run"); };
  await expect(verifyWorkerdImage({ ...entries, BP_WORKERD_DIGEST: "d".repeat(64) }, {}, unused)).rejects.toMatchObject({ error: "workerd_legacy_identity_requires_migration" });
  await expect(verifyWorkerdImage({ ...entries, BP_WORKERD_BINARY_SHA256: "wrong" }, {}, unused)).rejects.toMatchObject({ error: "workerd_identity_invalid" });
  await expect(verifyWorkerdImage(entries, {}, async () => "local:tag")).rejects.toMatchObject({ error: "workerd_image_identity_invalid" });
  state.hashes = hashes.replace(defaultWorkerdBinary, "d".repeat(64));
  await expect(verifyWorkerdImage(entries, {}, run)).rejects.toMatchObject({ error: "workerd_binary_identity_mismatch" });
  state.hashes = hashes.replace(supervisorBinary, "e".repeat(64));
  await expect(verifyWorkerdImage(entries, {}, run)).rejects.toMatchObject({ error: "workerd_binary_identity_mismatch" });
  state.hashes = hashes; state.missingBun = true;
  await expect(verifyWorkerdImage(entries, {}, run)).rejects.toThrow("missing executable");
  state.missingBun = false; state.bunVersion = "1.0.0";
  await expect(verifyWorkerdImage(entries, {}, run)).rejects.toMatchObject({ error: "workerd_binary_incompatible" });
  state.bunVersion = "1.4.2"; state.workerdVersion = "";
  await expect(verifyWorkerdImage(entries, {}, run)).rejects.toMatchObject({ error: "workerd_binary_incompatible" });
});

test("verification and private launch evidence preserve the resolved image across retags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-runtime-evidence-"));
  const { images, run } = dockerFixture();
  const secondId = "sha256:" + "d".repeat(64);
  try {
    const first = await verifyWorkerdImage(entries, { BP_COMPUTE_TOKEN: "never-record" }, async (args, env) => {
      const result = await run(args, env);
      if (args[0] === "image") images.set(entries.BP_WORKERD_IMAGE, secondId);
      return result;
    });
    expect(first.imageId).toBe(imageId);
    const path = await persistWorkerdEvidence(directory, first), before = await privateRead(path);
    expect(JSON.parse(before ?? "null")).toEqual({ source: "host-declared", purpose: "launch-decision", selectedReference: entries.BP_WORKERD_IMAGE,
      hostObservedImageId: imageId, binarySha256: defaultWorkerdBinary, supervisorBinarySha256: supervisorBinary,
      workerdVersion: "workerd 2026-09-18", supervisorVersion: "1.4.2", architecture: "amd64", observedAt: first.observedAt });
    expect(Number.isFinite(Date.parse(first.observedAt))).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(before).not.toContain("never-record");
    const second = await verifyWorkerdImage(entries, {}, run);
    await persistWorkerdEvidence(directory, second);
    expect(second.imageId).toBe(secondId);
    expect(await privateRead(path)).toBe(before);
    expect((await readdir(join(directory, "compute"))).every(name => name.endsWith(".json"))).toBe(true);
    expect(await readdir(join(directory, "compute"))).toHaveLength(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
