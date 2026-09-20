// Standalone provisioning entrypoint; never imports the application. RustFS 1.0.0-rc.6 reports a missing service account as NoSuchResource.
import { createHash, createHmac } from "node:crypto";

let step = "configuration";
const assert = (ok) => { if (!ok) throw Error(step); };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const mac = (k, s) => createHmac("sha256", k).update(s).digest();
const env = (k) => { const v = process.env[k]; assert(v); return v; };
const deadline = setTimeout(() => { console.error("blob_bootstrap_timeout"); process.exit(1); }, 180000);

// RustFS may serialize policy JSON as text and include empty optional fields.
function normalizePolicy(policy) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, normalize(item)])
      .filter(([, item]) => item !== null && item !== "" && !(typeof item === "object" && Object.keys(item).length === 0)));
    return value;
  };
  return JSON.stringify(normalize(typeof policy === "string" ? JSON.parse(policy) : policy));
}

async function main() {
  step = "image_reference";
  for (const name of ["BP_RUSTFS_IMAGE", "BP_BLOB_BOOTSTRAP_IMAGE"])
    assert(/^[^\s$]+$/.test(env(name)));
  if (process.argv.includes("--images")) return;

  step = "credentials";
  const root = env("BP_RUSTFS_ROOT_USER");
  const password = env("BP_RUSTFS_ROOT_PASSWORD");
  const accessKey = env("BP_BLOB_S3_ACCESS_KEY");
  const secretKey = env("BP_BLOB_S3_SECRET_KEY");
  const bucket = env("BP_BLOB_S3_BUCKET");
  assert(root !== accessKey && password !== secretKey);
  assert([root, accessKey].every(v => /^[A-Za-z0-9_-]{3,64}$/.test(v)));
  step = "bucket_name";
  assert(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket));
  const origin = "http://rustfs:9000";
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {Effect:"Allow", Action:["s3:ListBucket"],
       Resource:[`arn:aws:s3:::${bucket}`]},
      {Effect:"Allow",
       Action:["s3:GetObject","s3:PutObject","s3:DeleteObject"],
       Resource:[`arn:aws:s3:::${bucket}/*`]}
    ]
  };

  async function request(method, path, body = "", key = root, secret = password) {
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = date.slice(0, 8), scope = `${day}/us-east-1/s3/aws4_request`;
    const url = new URL(path, origin);
    const headers = {
      host: url.host,
      "x-amz-content-sha256": sha(body),
      "x-amz-date": date
    };
    const names = Object.keys(headers).sort();
    const signed = names.join(";");
    const canonical = [
      method, url.pathname, url.search.slice(1),
      names.map(n => `${n}:${headers[n]}\n`).join(""),
      signed, sha(body)
    ].join("\n");
    let signingKey = Buffer.from(`AWS4${secret}`);
    for (const part of [day, "us-east-1", "s3", "aws4_request"])
      signingKey = mac(signingKey, part);
    const signature = mac(signingKey,
      `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonical)}`
    ).toString("hex");
    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
    const response = await fetch(url, {
      method, headers: {...headers, "content-type":"application/json"},
      ...(body ? {body} : {}),
      redirect:"error", signal:AbortSignal.timeout(5000)
    });
    return {ok:response.ok, status:response.status, text:await response.text()};
  }
  const checked = async (...args) => {
    const r = await request(...args); assert(r.ok); return r.text;
  };

  step = "readiness";
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    ready = await fetch(`${origin}/health/ready`, {
      redirect:"error", signal:AbortSignal.timeout(2000)
    }).then(async r => { await r.body?.cancel(); return r.status === 200; })
      .catch(() => false);
    if (ready) break;
    await Bun.sleep(1000);
  }
  assert(ready);

  step = "bucket_create";
  const created = await request("PUT", `/${bucket}`);
  assert(created.ok || (created.status === 409 &&
    created.text.includes("<Code>BucketAlreadyOwnedByYou</Code>")));
  step = "versioning";
  const versioning = (await checked("GET", `/${bucket}?versioning=`))
    .replace(/<\?xml.*?\?>/s, "").trim();
  assert(/^<VersioningConfiguration\b[^>]*(?:\/>|>\s*<\/VersioningConfiguration>)$/.test(versioning));

  const admin = "/rustfs/admin/v3/";
  const query = `?accessKey=${encodeURIComponent(accessKey)}`;
  step = "account_info";
  const info = await request("GET", `${admin}info-service-account${query}`);
  if (info.ok) {
    step = "account_owner";
    assert(JSON.parse(info.text).parentUser === root);
    step = "account_update";
    await checked("POST", `${admin}update-service-account${query}`,
      JSON.stringify({newSecretKey:secretKey, newPolicy:policy, newStatus:"on"}));
  } else {
    step = "account_missing";
    assert(info.status === 404 &&
      /<Code>(?:XMinioAdmin)?(?:NoSuchServiceAccount|NoSuchResource)<\/Code>/.test(info.text));
    step = "account_create";
    await checked("PUT", `${admin}add-service-account`,
      JSON.stringify({targetUser:root, accessKey, secretKey, policy}));
  }
  step = "account_verify";
  const final = JSON.parse(await checked("GET", `${admin}info-service-account${query}`));
  assert(final.parentUser === root && final.impliedPolicy === false);
  step = "policy_mismatch";
  assert(normalizePolicy(final.policy) === normalizePolicy(policy));
  step = "scoped_access";
  await checked("GET", `/${bucket}?list-type=2&max-keys=1`, "", accessKey, secretKey);
}

try { await main(); }
catch { console.error(`blob_bootstrap_${step}`); process.exitCode = 1; }
finally { clearTimeout(deadline); }
