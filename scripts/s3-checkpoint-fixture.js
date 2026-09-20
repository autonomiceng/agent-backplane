// Disposable drill only: an owned extra object simulates bytes left by an interrupted upload.
import { S3Client } from "bun";
import { createHash } from "node:crypto";

let step = "identity";
try {
  const [mode, workspace, id] = process.argv.slice(2);
  if (![workspace, id].every(value => /^[0-9a-f-]{36}$/.test(value ?? ""))) throw new Error("fixture identity");
  step = "configuration";
  const client = new S3Client({ endpoint: process.env.BP_BLOB_S3_ENDPOINT, region: process.env.BP_BLOB_S3_REGION,
    bucket: process.env.BP_BLOB_S3_BUCKET, accessKeyId: process.env.BP_BLOB_S3_ACCESS_KEY, secretAccessKey: process.env.BP_BLOB_S3_SECRET_KEY });
  const key = `${workspace}/${id}`, bytes = Buffer.from("retained crash bytes");
  if (mode === "extra") {
    step = "create";
    const response = await fetch(client.presign(key, { method: "PUT", expiresIn: 60 }), { method: "PUT",
      headers: { "If-None-Match": "*" }, body: bytes, redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("fixture create");
    await response.body?.cancel();
  } else if (mode !== "read") throw new Error("fixture mode");
  step = "read";
  const response = await fetch(client.presign(key, { method: "GET", expiresIn: 60 }), { redirect: "error", signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("fixture read");
  const actual = Buffer.from(await response.arrayBuffer());
  console.log(JSON.stringify({ id, size: actual.length, sha256: createHash("sha256").update(actual).digest("hex") }));
} catch {
  console.error(`checkpoint_fixture_${step}`);
  process.exitCode = 1;
}
