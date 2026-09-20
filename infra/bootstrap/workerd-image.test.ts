import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateRead } from "../../packages/cli/runtime/credential-file.ts";
import { defaultWorkerdBinary, persistWorkerdEvidence, verifyWorkerdImage } from "./workerd-image.ts";
import type { Runner } from "./prepare.ts";

const imageId = "sha256:" + "c".repeat(64), entries = { BP_WORKERD_IMAGE: "local/workerd:experiment" };
const run: Runner = async args => args[0] === "image" ? `${imageId} amd64` : `${defaultWorkerdBinary}  /usr/bin/workerd\n`;
test("local tag is resolved once and verification uses that immutable image ID", async () => {
  const calls: string[][] = [];
  const result = await verifyWorkerdImage(entries, {}, async (args, env) => { calls.push(args); return run(args, env); });
  expect(result).toMatchObject({ reference: entries.BP_WORKERD_IMAGE, imageId, binarySha256: defaultWorkerdBinary, architecture: "amd64" });
  expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
  expect(calls[0]?.at(-1)).toBe(entries.BP_WORKERD_IMAGE);
  expect(calls[1]?.slice(-2)).toEqual([imageId, "/usr/bin/workerd"]);
  expect(calls[1]).toContain("none");
  expect(calls[1]).toContain("never");
});
test("missing or empty references refuse before Docker; there is no default image", async () => {
  const unused: Runner = async () => { throw Error("must not run"); };
  for (const value of [{}, { BP_WORKERD_IMAGE: "" }]) {
    await expect(verifyWorkerdImage(value, {}, unused)).rejects.toMatchObject({ error: "workerd_image_required" });
  }
});
test("legacy, malformed facts, other architecture without a pin and wrong binary fail closed", async () => {
  const unused: Runner = async () => { throw Error("must not run"); };
  await expect(verifyWorkerdImage({ ...entries, BP_WORKERD_DIGEST: "d".repeat(64) }, {}, unused)).rejects.toMatchObject({ error: "workerd_legacy_identity_requires_migration" });
  await expect(verifyWorkerdImage({ ...entries, BP_WORKERD_BINARY_SHA256: "wrong" }, {}, unused)).rejects.toMatchObject({ error: "workerd_identity_invalid" });
  await expect(verifyWorkerdImage(entries, {}, async () => "local:tag")).rejects.toMatchObject({ error: "workerd_image_identity_invalid" });
  await expect(verifyWorkerdImage(entries, {}, async () => `${imageId} arm64`)).rejects.toMatchObject({ error: "workerd_binary_pin_required" });
  await expect(verifyWorkerdImage(entries, {}, async args => args[0] === "image" ? `${imageId} amd64` : `${"d".repeat(64)}  /usr/bin/workerd`)).rejects.toMatchObject({ error: "workerd_binary_identity_mismatch" });
});
test("private durable launch records preserve observations across retags without selecting future images", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bp-runtime-evidence-"));
  try {
    const first = await verifyWorkerdImage(entries, { BP_COMPUTE_TOKEN: "never-record" }, run);
    const path = await persistWorkerdEvidence(directory, first), before = await privateRead(path);
    expect(JSON.parse(before ?? "null")).toEqual({ source: "host-declared", purpose: "launch-decision", selectedReference: entries.BP_WORKERD_IMAGE,
      hostObservedImageId: imageId, binarySha256: defaultWorkerdBinary, architecture: "amd64", observedAt: first.observedAt });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(before).not.toContain("never-record");
    const secondId = "sha256:" + "d".repeat(64);
    const second = await verifyWorkerdImage(entries, {}, async args => args[0] === "image" ? `${secondId} amd64` : run(args, {}));
    await persistWorkerdEvidence(directory, second);
    expect(second.imageId).toBe(secondId);
    expect(await privateRead(path)).toBe(before);
    expect((await readdir(join(directory, "compute"))).every(name => name.endsWith(".json"))).toBe(true);
    expect(await readdir(join(directory, "compute"))).toHaveLength(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
