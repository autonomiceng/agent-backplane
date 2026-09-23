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
const supervisorBinaries = new Map([
  ["amd64", "a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c"],
  ["arm64", "616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1"],
]);
// `published` is the default reference rendered from compose.compute.yaml, the single pin Renovate updates.
export async function verifyWorkerdImage(entries: Environment, env: Environment, run: Runner, published: string) {
  if (entries.BP_WORKERD_REPOSITORY || entries.BP_WORKERD_DIGEST) throw new CliError("workerd_legacy_identity_requires_migration", 1);
  const pullDefault = !entries.BP_WORKERD_IMAGE;
  const reference = entries.BP_WORKERD_IMAGE || published;
  const binary = entries.BP_WORKERD_BINARY_SHA256 || defaultWorkerdBinary;
  if (!validImageReference(reference) || !/^[0-9a-f]{64}$/.test(binary)) throw new CliError("workerd_identity_invalid", 1);
  if (pullDefault) {
    if (binary !== defaultWorkerdBinary) throw new CliError("workerd_default_binary_mismatch", 1);
    const hostArchitecture = (await run(["info", "--format", "{{.Architecture}}"], env, 10_000)).trim();
    if (!["amd64", "x86_64"].includes(hostArchitecture)) throw new CliError("workerd_default_architecture_unqualified", 1);
    await run(["pull", "--platform", "linux/amd64", reference], env, 900_000);
  }
  const [imageId, architecture, extra] = (await run(["image", "inspect", "--format", "{{.Id}} {{.Architecture}}", reference], env, 10_000)).trim().split(" ");
  if (!imageId || !/^sha256:[0-9a-f]{64}$/.test(imageId) || !architecture || !/^[a-z0-9_-]{1,32}$/.test(architecture) || extra !== undefined) throw new CliError("workerd_image_identity_invalid", 1);
  if (pullDefault && architecture !== "amd64") throw new CliError("workerd_default_architecture_unqualified", 1);
  if (!entries.BP_WORKERD_BINARY_SHA256 && architecture !== "amd64") throw new CliError("workerd_binary_pin_required", 1);
  const supervisorBinary = supervisorBinaries.get(architecture);
  if (!supervisorBinary) throw new CliError("workerd_supervisor_architecture_unsupported", 1);
  const container = ["create", "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--user", "65534:65534", "--entrypoint"];
  const probe = async (executable: string, args: string[]) => {
    const id = (await run([...container, executable, imageId, ...args], env, 10_000)).trim();
    if (!/^[0-9a-f]{64}$/.test(id)) throw new CliError("workerd_verifier_identity_invalid", 1);
    try { return (await run(["start", "--attach", id], env, 10_000)).trim(); }
    finally { await run(["rm", "--force", id], env, 10_000); }
  };
  const observed = await probe("sha256sum", ["/usr/bin/workerd", "/usr/bin/bun"]);
  if (observed !== `${binary}  /usr/bin/workerd\n${supervisorBinary}  /usr/bin/bun`) throw new CliError("workerd_binary_identity_mismatch", 1);
  const workerdVersion = await probe("/usr/bin/workerd", ["--version"]);
  const supervisorVersion = await probe("/usr/bin/bun", ["--version"]);
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
