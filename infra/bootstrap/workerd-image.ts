// Docker stays on the trusted host. Each bootstrap resolves the operator's current reference.
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { validImageReference } from "../../apps/server/compute/runtime-identity.ts";
import { privateWrite } from "../../packages/cli/runtime/credential-file.ts";
import { CliError, type Environment } from "../../packages/cli/runtime/credentials.ts";
import type { Runner } from "./prepare.ts";
// Verified upstream amd64 executable, independent of any builder's image config ID.
export const defaultWorkerdBinary = "f31da6d248028d698806aa93d1b3aec28bbd4b4b7ddc31e967408ab6406fa5aa";
export async function verifyWorkerdImage(entries: Environment, env: Environment, run: Runner) {
  if (entries.BP_WORKERD_REPOSITORY || entries.BP_WORKERD_DIGEST) throw new CliError("workerd_legacy_identity_requires_migration", 1);
  const reference = entries.BP_WORKERD_IMAGE;
  if (!reference) throw new CliError("workerd_image_required", 1);
  const binary = entries.BP_WORKERD_BINARY_SHA256 || defaultWorkerdBinary;
  if (!validImageReference(reference) || !/^[0-9a-f]{64}$/.test(binary)) throw new CliError("workerd_identity_invalid", 1);
  const [imageId, architecture, extra] = (await run(["image", "inspect", "--format", "{{.Id}} {{.Architecture}}", reference], env)).trim().split(" ");
  if (!imageId || !/^sha256:[0-9a-f]{64}$/.test(imageId) || !architecture || !/^[a-z0-9_-]{1,32}$/.test(architecture) || extra !== undefined) throw new CliError("workerd_image_identity_invalid", 1);
  if (!entries.BP_WORKERD_BINARY_SHA256 && architecture !== "amd64") throw new CliError("workerd_binary_pin_required", 1);
  const observed = (await run(["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--user", "65534:65534", "--entrypoint", "sha256sum", imageId, "/usr/bin/workerd"], env)).trim();
  if (observed !== `${binary}  /usr/bin/workerd`) throw new CliError("workerd_binary_identity_mismatch", 1);
  return { reference, imageId, binarySha256: binary, architecture, observedAt: new Date().toISOString() };
}
// A durable private launch decision, even if Compose subsequently fails. Never used to select an image.
export async function persistWorkerdEvidence(dataDir: string, identity: Awaited<ReturnType<typeof verifyWorkerdImage>>) {
  const directory = join(dataDir, "compute");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${crypto.randomUUID()}.json`), temporary = `${path}.tmp`;
  const evidence = { source: "host-declared", purpose: "launch-decision", selectedReference: identity.reference,
    hostObservedImageId: identity.imageId, binarySha256: identity.binarySha256, architecture: identity.architecture, observedAt: identity.observedAt };
  await privateWrite(temporary, JSON.stringify(evidence) + "\n");
  try {
    await rename(temporary, path);
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(temporary, { force: true }); }
  return path;
}
