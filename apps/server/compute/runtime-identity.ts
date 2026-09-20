// Private identity protocol. Artifact facts are operator declarations, separate from measured code.
import { createHash } from "node:crypto";
export type ArtifactEvidence = { source: "host-declared"; reference: string; hostObservedImageId: string | null };
export type RuntimeEvidence = { runtimeDigest: string; controlHash: string; artifact: ArtifactEvidence };
export function validImageReference(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:@sha256:[0-9a-f]{64})?$/.test(value)
    && !value.includes("//") && !/[/:]$/.test(value);
}
export function readArtifactEvidence(value: string | null): ArtifactEvidence | null {
  if (!value || value.length > 1024) return null;
  try {
    const artifact: unknown = JSON.parse(value);
    if (!artifact || typeof artifact !== "object" || Object.keys(artifact).sort().join(",") !== "hostObservedImageId,reference,source"
      || !("source" in artifact) || artifact.source !== "host-declared"
      || !("reference" in artifact) || !validImageReference(artifact.reference)
      || !("hostObservedImageId" in artifact) || !(artifact.hostObservedImageId === null
        || typeof artifact.hostObservedImageId === "string" && /^sha256:[0-9a-f]{64}$/.test(artifact.hostObservedImageId))) return null;
    return { source: artifact.source, reference: artifact.reference, hostObservedImageId: artifact.hostObservedImageId };
  } catch { return null; }
}
// Matches: (cd /compute && sha256sum loader.js config.capnp start.sh supervisor.ts child-process.ts) | sha256sum
// Called explicitly during verification, never on import. Checkout updates require a runtime restart.
export async function readControlSurfaceHash(directory = new URL("./workerd/", import.meta.url)) {
  const lines = await Promise.all(["loader.js", "config.capnp", "start.sh", "supervisor.ts", "child-process.ts"].map(async name => {
    const bytes = await Bun.file(new URL(name, directory)).arrayBuffer();
    return `${createHash("sha256").update(new Uint8Array(bytes)).digest("hex")}  ${name}\n`;
  }));
  return createHash("sha256").update(lines.join("")).digest("hex");
}
