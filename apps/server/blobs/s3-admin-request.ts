// Narrow SigV4 boundary for private RustFS administration and its real-backend fixtures.
import { createHash, createHmac } from "node:crypto";
export async function s3AdminRequest(endpoint: string, access: string, secret: string, path: string, method: "GET" | "PUT" = "GET", body = "") {
  const url = new URL(path, endpoint), date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = date.slice(0, 8), scope = `${day}/us-east-1/s3/aws4_request`;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const headers = { host: url.host, "x-amz-content-sha256": hash(body), "x-amz-date": date };
  const signed = "host;x-amz-content-sha256;x-amz-date";
  const canonical = [method, url.pathname, url.search.slice(1),
    Object.entries(headers).map(([key, value]) => `${key}:${value}\n`).join(""), signed, hash(body)].join("\n");
  let key = Buffer.from(`AWS4${secret}`);
  for (const part of [day, "us-east-1", "s3", "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).digest("hex");
  return fetch(url, { method, ...(method === "PUT" ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signed}, Signature=${signature}` } });
}
