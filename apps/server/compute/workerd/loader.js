// Authenticated preparation endpoint; children receive no capabilities during module validation.
import { WorkerEntrypoint } from "cloudflare:workers";
const checkSource = `import {WorkerEntrypoint} from "cloudflare:workers";
import handler from "./bundle.js";
export class Check extends WorkerEntrypoint {
  check() { return handler !== null && typeof handler === "object" && typeof handler.fetch === "function"; }
}`;
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function authorized(value, token) {
  const digest = (text) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const [actual, expected] = await Promise.all([digest(value ?? ""), digest(`Bearer ${token}`)]);
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(actual, expected);
  const a = new Uint8Array(actual), b = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
function unavailable() { return new Response(null, { status: 503, headers: { "x-backplane-error": "compute_unavailable" } }); }
export default {
  async fetch(request, env, ctx) {
    if (!env.TOKEN || !await authorized(request.headers.get("authorization"), env.TOKEN)) return new Response(null, { status: 401 });
    if (!/^workerd-binary-sha256:[0-9a-f]{64}$/.test(env.RUNTIME_ID ?? "") || !/^[0-9a-f]{64}$/.test(env.CONTROL_SHA256 ?? "")) return unavailable();
    const artifact = JSON.stringify({ source: "host-declared", reference: env.IMAGE_REFERENCE, hostObservedImageId: env.HOST_IMAGE_ID || null });
    if (artifact.length > 1024) return unavailable();
    if (request.method === "GET" && new URL(request.url).pathname === "/identity") {
      return new Response(null, { status: 204, headers: {
        "x-backplane-runtime": env.RUNTIME_ID, "x-backplane-control": env.CONTROL_SHA256, "cache-control": "no-store",
        "x-backplane-artifact": artifact,
      } });
    }
    const invocation = new URL(request.url).pathname === "/invoke";
    if (request.method !== "POST" || (!invocation && new URL(request.url).pathname !== "/prepare")) return new Response(null, { status: 404 });
    // Bind the admission observation to this loader before reading a bundle or creating a child.
    if (request.headers.get("x-backplane-runtime") !== env.RUNTIME_ID
      || request.headers.get("x-backplane-control") !== env.CONTROL_SHA256
      || request.headers.get("x-backplane-artifact") !== artifact) return unavailable();
    try {
      const reader = request.body?.getReader(), chunks = [];
      let size = 0;
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 6 * 4194304 + 1048576 + 65536) { void reader.cancel(); throw Error("bundle_invalid"); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const envelope = JSON.parse(new TextDecoder().decode(bytes)), m = invocation ? envelope.manifest : envelope;
      if (m.runtimeDigest !== env.RUNTIME_ID) return unavailable();
      if (m.version !== 1 || m.entryPoint !== "default" || m.compatibilityDate !== "2026-01-01"
        || typeof m.bundle !== "string" || new TextEncoder().encode(m.bundle).length > 4194304
        || m.keyRef.workspaceId !== m.workspaceId || !/^workerd-binary-sha256:[0-9a-f]{64}$/.test(m.runtimeDigest)) throw Error("bundle_invalid");
      const urls = [...new Set(m.outboundUrls.map((value) => {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.hash) throw Error("bundle_invalid");
        return url.href;
      }))].sort();
      if (urls.length > 16 || JSON.stringify(urls) !== JSON.stringify(m.outboundUrls)
        || await sha256(m.bundle) !== m.bundleSha256
        || await sha256(JSON.stringify([1, m.bundleSha256, m.entryPoint, m.compatibilityDate, urls,
          [m.keyRef.workspaceId, m.keyRef.principalId], m.runtimeDigest, await sha256(checkSource)])) !== m.configHash) throw Error("bundle_invalid");
      if (invocation) {
        const { props, input } = envelope;
        if (!props || Object.keys(props).sort().join(",") !== "runId,token,workspaceId" || props.workspaceId !== m.workspaceId
          || !/^[0-9a-f-]{36}$/.test(props.runId) || !/^bp_i_[0-9a-f]{64}$/.test(props.token)) throw Error("bundle_invalid");
        const worker = env.LOADER.get(null, () => ({
          compatibilityDate: m.compatibilityDate, compatibilityFlags: [], mainModule: "invoke.js",
          modules: { "bundle.js": m.bundle, "invoke.js": `import handler from "./bundle.js";
            export default { fetch(request, env, ctx) { return handler.fetch(request, ctx.props, ctx); } };` },
          env: {}, globalOutbound: ctx.exports.Egress({ props: { workspaceId: m.workspaceId, urls: m.outboundUrls } }),
        }));
        const child = await worker.getEntrypoint(null, { props }).fetch(new Request("https://function.invalid/invoke", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
        }));
        const headers = new Headers(child.headers);
        headers.delete("x-backplane-error");
        return new Response(child.body, { status: child.status, statusText: child.statusText, headers });
      }
      const worker = env.LOADER.get(`${m.workspaceId}/${m.id}/${m.configHash}/prepare`, () => ({
        compatibilityDate: m.compatibilityDate, compatibilityFlags: [], mainModule: "check.js",
        modules: { "bundle.js": m.bundle, "check.js": checkSource }, env: {}, globalOutbound: null,
      }));
      if (!await worker.getEntrypoint("Check").check()) throw Error("bundle_invalid");
      return new Response(null, { status: 204 });
    } catch { return Response.json({ error: "bundle_invalid" }, { status: 422 }); }
  },
};
// S31 execution binds this entrypoint through ctx.exports with immutable Workspace and URL props.
export class Egress extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url), { workspaceId, urls } = this.ctx.props;
    if (request.method === "CONNECT" || request.headers.has("upgrade") || url.username || url.password || url.hash) return new Response(null, { status: 403 });
    const api = url.origin === "http://server:3000";
    if (api ? !url.pathname.startsWith(`/api/v1/workspaces/${workspaceId}/`)
      : url.protocol !== "https:" || !urls.includes(url.href)) return new Response(null, { status: 403 });
    const forwarded = new Request(request, { redirect: "manual" });
    const response = api ? await this.env.API.fetch(forwarded) : await fetch(forwarded);
    if (response.status === 101 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      return new Response(null, { status: 403 });
    }
    return response;
  }
}
