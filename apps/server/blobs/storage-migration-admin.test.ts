import { expect, test } from "bun:test";
import { migrationCredentialsCommitment } from "./storage-migration-admin.ts";

test("migration credential commitment preserves Python ASCII JSON encoding for Unicode and UTF-16 edge cases", async () => {
  const id = "69cb3620-a154-43ed-8664-6c1c6af14832";
  const credentials = ["root-é", "astral-🚀\u2028\u2029", "del-\u007f-lone-\ud800", "quote-\"-slash-\\-controls-\b\f\n\r\t\u0000"];
  const child = Bun.spawn(["python3", "-c", `import hashlib,json,sys
from types import SimpleNamespace
sys.path.insert(0,'.')
from checkpoint import credentials_digest
name, *values = json.load(sys.stdin)
keys = ('BP_RUSTFS_ROOT_USER','BP_RUSTFS_ROOT_PASSWORD','BP_BLOB_S3_ACCESS_KEY','BP_BLOB_S3_SECRET_KEY')
stack = SimpleNamespace(services={'blob-bootstrap':{'environment':dict(zip(keys,values))}})
print(credentials_digest(stack,name,hashlib.sha256(name.encode()).hexdigest()))`],
    { cwd: new URL("../../../scripts/", import.meta.url).pathname, stdin: new Blob([JSON.stringify([id, ...credentials])]), stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, err).toBe(0);
  expect(migrationCredentialsCommitment(id, credentials)).toBe(out.trim());
});
