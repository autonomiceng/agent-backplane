// Read-only counterpart of infra/init/blobs/bootstrap.js's signer. Importing bootstrap would mutate IAM.
import { createHash, createHmac } from "node:crypto";

try {
  const required = name => {
    const value = process.env[name];
    if (!value) throw new Error("configuration");
    return value;
  };
  const root = required("BP_RUSTFS_ROOT_USER"), secret = required("BP_RUSTFS_ROOT_PASSWORD");
  const access = required("BP_BLOB_S3_ACCESS_KEY"), bucket = required("BP_BLOB_S3_BUCKET");
  const sha = value => createHash("sha256").update(value).digest("hex");
  async function read(path) {
    const url = new URL(path, "http://rustfs:9000"), date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = date.slice(0, 8), scope = `${day}/us-east-1/s3/aws4_request`;
    const headers = { host: url.host, "x-amz-content-sha256": sha(""), "x-amz-date": date };
    const signed = "host;x-amz-content-sha256;x-amz-date";
    const canonical = ["GET", url.pathname, url.search.slice(1),
      Object.entries(headers).map(([key, value]) => `${key}:${value}\n`).join(""), signed, sha("")].join("\n");
    let key = Buffer.from(`AWS4${secret}`);
    for (const part of [day, "us-east-1", "s3", "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
    const signature = createHmac("sha256", key).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`).digest("hex");
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${root}/${scope}, SignedHeaders=${signed}, Signature=${signature}` } });
    if (!response.ok) throw new Error("authentication");
    return response.text();
  }
  const info = JSON.parse(await read(`/rustfs/admin/v3/info-service-account?accessKey=${encodeURIComponent(access)}`));
  if (info.parentUser !== root || info.impliedPolicy !== false) throw new Error("account");
  const versioning = (await read(`/${encodeURIComponent(bucket)}?versioning=`)).replace(/<\?xml.*?\?>/s, "").trim();
  if (!/^<VersioningConfiguration\b[^>]*(?:\/>|>\s*<\/VersioningConfiguration>)$/.test(versioning)) throw new Error("versioning");
} catch {
  console.error("checkpoint_root_or_bucket_proof_failed");
  process.exitCode = 1;
}
