// Docker stays on the trusted host. Each bootstrap resolves the operator's current reference.
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validImageReference } from "../../apps/server/compute/runtime-identity.ts";
import { privateWrite } from "../../packages/cli/runtime/credential-file.ts";
import { CliError, type Environment } from "../../packages/cli/runtime/credentials.ts";
import type { Runner } from "./prepare.ts";
// Verified upstream amd64 executable, independent of any builder's image config ID.
export const defaultWorkerdBinary = "f31da6d248028d698806aa93d1b3aec28bbd4b4b7ddc31e967408ab6406fa5aa";
export const defaultWorkerdImage = "agent-backplane-workerd:1.20260918.1";
const supervisorBinaries = new Map([
  ["amd64", "a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c"],
  ["arm64", "616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1"],
]);
export async function verifyWorkerdImage(entries: Environment, env: Environment, run: Runner) {
  if (entries.BP_WORKERD_REPOSITORY || entries.BP_WORKERD_DIGEST) throw new CliError("workerd_legacy_identity_requires_migration", 1);
  const buildDefault = !entries.BP_WORKERD_IMAGE;
  const reference = entries.BP_WORKERD_IMAGE || defaultWorkerdImage;
  const binary = entries.BP_WORKERD_BINARY_SHA256 || defaultWorkerdBinary;
  if (!validImageReference(reference) || !/^[0-9a-f]{64}$/.test(binary)) throw new CliError("workerd_identity_invalid", 1);
  if (buildDefault) {
    if (binary !== defaultWorkerdBinary) throw new CliError("workerd_default_binary_mismatch", 1);
    const hostArchitecture = (await run(["info", "--format", "{{.Architecture}}"], env)).trim();
    if (!["amd64", "x86_64"].includes(hostArchitecture)) throw new CliError("workerd_default_architecture_unqualified", 1);
    const context = resolve(import.meta.dir, "../compute/image");
    await run(["build", "--platform", "linux/amd64", "--file", join(context, "Dockerfile"), "--tag", reference, context], env);
  }
  const [imageId, architecture, extra] = (await run(["image", "inspect", "--format", "{{.Id}} {{.Architecture}}", reference], env)).trim().split(" ");
  if (!imageId || !/^sha256:[0-9a-f]{64}$/.test(imageId) || !architecture || !/^[a-z0-9_-]{1,32}$/.test(architecture) || extra !== undefined) throw new CliError("workerd_image_identity_invalid", 1);
  if (buildDefault && architecture !== "amd64") throw new CliError("workerd_default_architecture_unqualified", 1);
  if (!entries.BP_WORKERD_BINARY_SHA256 && architecture !== "amd64") throw new CliError("workerd_binary_pin_required", 1);
  const supervisorBinary = supervisorBinaries.get(architecture);
  if (!supervisorBinary) throw new CliError("workerd_supervisor_architecture_unsupported", 1);
  const container = ["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--user", "65534:65534", "--entrypoint"];
  const observed = (await run([...container, "sha256sum", imageId, "/usr/bin/workerd", "/usr/bin/bun"], env)).trim();
  if (observed !== `${binary}  /usr/bin/workerd\n${supervisorBinary}  /usr/bin/bun`) throw new CliError("workerd_binary_identity_mismatch", 1);
  const workerdVersion = (await run([...container, "/usr/bin/workerd", imageId, "--version"], env)).trim();
  const supervisorVersion = (await run([...container, "/usr/bin/bun", imageId, "--version"], env)).trim();
  const compatibleWorkerd = binary === defaultWorkerdBinary ? workerdVersion === "workerd 2026-09-18" : /^workerd \d{4}-\d{2}-\d{2}$/.test(workerdVersion);
  if (!compatibleWorkerd || supervisorVersion !== "1.4.2") throw new CliError("workerd_binary_incompatible", 1);
  return { reference, imageId, binarySha256: binary, supervisorBinarySha256: supervisorBinary,
    workerdVersion, supervisorVersion, architecture, observedAt: new Date().toISOString() };
}
// A durable private launch decision, even if Compose subsequently fails. Never used to select an image.
export async function persistWorkerdEvidence(dataDir: string, identity: Awaited<ReturnType<typeof verifyWorkerdImage>>) {
  const directory = join(dataDir, "compute");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${crypto.randomUUID()}.json`), temporary = `${path}.tmp`;
  const evidence = { source: "host-declared", purpose: "launch-decision", selectedReference: identity.reference,
    hostObservedImageId: identity.imageId, binarySha256: identity.binarySha256, supervisorBinarySha256: identity.supervisorBinarySha256,
    workerdVersion: identity.workerdVersion, supervisorVersion: identity.supervisorVersion, architecture: identity.architecture, observedAt: identity.observedAt };
  await privateWrite(temporary, JSON.stringify(evidence) + "\n");
  try {
    await rename(temporary, path);
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(temporary, { force: true }); }
  return path;
}
