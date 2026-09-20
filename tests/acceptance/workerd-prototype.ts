// Explicit host prototype. It requires a qualified local binary; it never uses Docker.
import { createHash } from "node:crypto";
import { createSupervisor, supervisorTransportLimit } from "../../apps/server/compute/workerd/supervisor.ts";
import { readControlSurfaceHash } from "../../apps/server/compute/runtime-identity.ts";

const binary = Bun.env.BP_TEST_WORKERD_BINARY;
if (!binary) throw Error("BP_TEST_WORKERD_BINARY required");
const observed = createHash("sha256").update(await Bun.file(binary).bytes()).digest("hex");
if (observed !== Bun.env.BP_WORKERD_BINARY_SHA256) throw Error("prototype binary checksum mismatch");
const runtimeDigest = `workerd-binary-sha256:${observed}`;
const supervisor = createSupervisor({ binary, config: new URL("../../apps/server/compute/workerd/config.capnp", import.meta.url).pathname,
  timeoutMs: Number(Bun.env.BP_COMPUTE_TIMEOUT_MS ?? 10000), token: Bun.env.BP_COMPUTE_TOKEN ?? "", args: [`--external-addr=api=${Bun.env.BP_TEST_API_ADDRESS ?? "127.0.0.1:9"}`],
  env: { ...Bun.env, BP_WORKERD_RUNTIME_ID: runtimeDigest, BP_WORKERD_CONTROL_SHA256: await readControlSurfaceHash(),
    BP_WORKERD_IMAGE: "prototype:host", BP_WORKERD_HOST_IMAGE_ID: "" } });
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(Bun.env.BP_TEST_SUPERVISOR_PORT ?? 0), maxRequestBodySize: supervisorTransportLimit, fetch: supervisor.fetch });
console.log(JSON.stringify({ url: server.url.href, runtimeDigest }));
const close = async () => { await supervisor.close(); await server.stop(true); process.exit(0); };
process.on("SIGTERM", close); process.on("SIGINT", close);
