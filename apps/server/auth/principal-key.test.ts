import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decidePrincipalKey, parsePrincipalKey } from "./principal-key.ts";
import { generatePrincipalKey, verifyPrincipalSecret } from "./principal-key-crypto.ts";

test("credential parsing accepts trailing input or hashes secret text instead of secret bytes", () => {
  const material = generatePrincipalKey();
  const parsed = parsePrincipalKey(`Bearer ${material.key}`);
  expect(parsed).not.toBeNull();
  expect(parsed?.prefix).toBe(material.prefix);
  const secret = parsed!.secret;
  expect(material.secretHash).toEqual(createHash("sha256").update(Buffer.from(secret, "hex")).digest());
  expect(verifyPrincipalSecret(secret, material.secretHash)).toBe(true);
  expect(verifyPrincipalSecret(secret, null)).toBe(false);
  expect(parsePrincipalKey(`Bearer ${material.key}\n`)).toBeNull();
  const facts = { workspaceId: "workspace", principalId: "principal", status: "active", revokedAt: null };
  expect(decidePrincipalKey(facts, true)).toEqual({ status: "authenticated", principal: { workspaceId: "workspace", principalId: "principal" } });
  expect(decidePrincipalKey(null, false)).toEqual({ status: "unknown" });
  expect(decidePrincipalKey(facts, false)).toEqual({ status: "mismatch" });
  expect(decidePrincipalKey({ ...facts, status: "revoked" }, true)).toEqual({ status: "revoked" });
  expect(decidePrincipalKey({ ...facts, revokedAt: new Date() }, true)).toEqual({ status: "revoked" });
});
