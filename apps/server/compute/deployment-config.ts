// Immutable manifest identity shared by registration and preparation.
import { createHash } from "node:crypto";
export const compatibilityDate = "2026-01-01";
export const checkSource = `import {WorkerEntrypoint} from "cloudflare:workers";
import handler from "./bundle.js";
export class Check extends WorkerEntrypoint {
  check() { return handler !== null && typeof handler === "object" && typeof handler.fetch === "function"; }
}`;
export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function normalizeUrls(urls: string[]): string[] | null {
  const normalized: string[] = [];
  for (const value of urls) {
    if (!URL.canParse(value)) return null;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    normalized.push(url.href);
  }
  return [...new Set(normalized)].sort();
}
export type Manifest = {
  version: 1; workspaceId: string; functionName: string; id: string; bundle: string; bundleSha256: string;
  entryPoint: "default"; compatibilityDate: string; outboundUrls: string[];
  keyRef: { workspaceId: string; principalId: string }; runtimeDigest: string; configHash: string;
};
export function configHash(m: Omit<Manifest, "configHash">): string {
  return sha256(JSON.stringify([m.version, m.bundleSha256, m.entryPoint, m.compatibilityDate,
    m.outboundUrls, [m.keyRef.workspaceId, m.keyRef.principalId], m.runtimeDigest, sha256(checkSource)]));
}
