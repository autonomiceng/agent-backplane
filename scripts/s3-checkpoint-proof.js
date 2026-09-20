// Read-only RustFS authentication, scoped account and versioning proof.
import { s3AdminRequest } from "../apps/server/blobs/s3-admin-request.ts";
import { writeSync } from "node:fs";

let step = "configuration";
// The deadline lives in the helper; terminating a Docker client would leave it running.
const deadline = setTimeout(() => { writeSync(2, `checkpoint_proof_${step}\n`); process.exit(1); }, 60000);
try {
  const required = name => {
    const value = process.env[name];
    if (!value) throw new Error("configuration");
    return value;
  };
  const root = required("BP_RUSTFS_ROOT_USER"), secret = required("BP_RUSTFS_ROOT_PASSWORD");
  const access = required("BP_BLOB_S3_ACCESS_KEY"), bucket = required("BP_BLOB_S3_BUCKET");
  async function read(path) {
    const response = await s3AdminRequest("http://rustfs:9000", root, secret, path);
    if (!response.ok) throw new Error("authentication");
    return response.text();
  }
  step = "readiness";
  const readyDeadline = Date.now() + 30000;
  for (;;) {
    const remaining = readyDeadline - Date.now();
    if (remaining <= 0) throw new Error("readiness");
    const response = await fetch("http://rustfs:9000/health/ready", { redirect: "error", signal: AbortSignal.timeout(Math.min(1000, remaining)) }).catch(() => null);
    await response?.body?.cancel();
    if (response?.ok) break;
    await Bun.sleep(Math.min(1000, Math.max(0, readyDeadline - Date.now())));
  }
  step = "authentication";
  const account = await read(`/rustfs/admin/v3/info-service-account?accessKey=${encodeURIComponent(access)}`);
  step = "account";
  const info = JSON.parse(account);
  if (info.parentUser !== root || info.impliedPolicy !== false) throw new Error("account");
  step = "versioning";
  const versioning = (await read(`/${encodeURIComponent(bucket)}?versioning=`)).replace(/<\?xml.*?\?>/s, "").trim();
  if (!/^<VersioningConfiguration\b[^>]*(?:\/>|>\s*<\/VersioningConfiguration>)$/.test(versioning)) throw new Error("versioning");
} catch {
  console.error(`checkpoint_proof_${step}`);
  process.exitCode = 1;
} finally { clearTimeout(deadline); }
