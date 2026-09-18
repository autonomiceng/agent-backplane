// Startup alone selects the durable backend; switching requires an operator migration.
import { filesystemStore } from "./filesystem-store.ts";
import { s3Store } from "./s3-store.ts";
export function createBlobStore(env: Record<string, string | undefined>, dataDir: string) {
  if (!env.BP_BLOB_BACKEND || env.BP_BLOB_BACKEND === "filesystem") return filesystemStore(dataDir);
  if (env.BP_BLOB_BACKEND !== "s3") throw new Error("BP_BLOB_BACKEND must be filesystem or s3");
  const required = (name: string) => { const value = env[`BP_BLOB_S3_${name}`]; if (!value) throw new Error(`BP_BLOB_S3_${name} is required`); return value; };
  return s3Store({ endpoint: required("ENDPOINT"), bucket: required("BUCKET"), accessKeyId: required("ACCESS_KEY"),
    secretAccessKey: required("SECRET_KEY"), region: env.BP_BLOB_S3_REGION ?? "us-east-1" });
}
