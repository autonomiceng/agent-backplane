// Credential material for issuance and verification; only the issue response receives the plaintext key.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashPrincipalSecret(secret: string): Buffer {
  return createHash("sha256").update(Buffer.from(secret, "hex")).digest();
}

export function generatePrincipalKey(): { key: string; prefix: string; secretHash: Buffer } {
  const prefix = randomBytes(12).toString("hex");
  const secret = randomBytes(32).toString("hex");
  return { key: `bp_${prefix}_${secret}`, prefix, secretHash: hashPrincipalSecret(secret) };
}

export function verifyPrincipalSecret(secret: string, storedHash: Uint8Array | null): boolean {
  // Unknown prefixes still take the fixed-length digest comparison path.
  return timingSafeEqual(hashPrincipalSecret(secret), storedHash ?? Buffer.alloc(32));
}
