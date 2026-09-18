// Offline app composition; no application endpoint, socket or database connection is opened.
import { createApp } from "../../apps/server/app.ts";
import { createEnrollment } from "../../apps/server/auth/enrollment.ts";
import { createAuth } from "../../apps/server/auth/auth.ts";
import { createPool } from "../../apps/server/platform/pool.ts";
import { commands, declaration, object, stable } from "../codegen/commands.ts";

export async function document(): Promise<string> {
  const pool = createPool("postgres://bp_server:unused@127.0.0.1:1/offline");
  const config = { publicOrigin: "http://localhost", authSecret: "offline-export-secret-longer-than-32-characters" };
  try {
    const enrollment = createEnrollment(pool, { ...config, signup: "closed", dataDir: "/offline" });
    const app = createApp({ enrollment, pool, expectedSchemaVersion: 0, auth: createAuth(pool, config), authUrl: config.publicOrigin }).compile();
    // The plugin invents operation IDs, so require declarations before it serializes routes.
    for (const route of app.routes) {
      if (route.path.startsWith("/api/openapi") || route.hooks.detail?.hide) continue;
      declaration(route.hooks.detail);
    }
    const response = await app.handle(new Request("http://localhost/api/openapi/json"));
    if (!response.ok) throw new Error(`OpenAPI export failed: ${response.status}`);
    const doc: unknown = await response.json();
    for (const path of Object.values(object(object(doc).paths))) for (const op of Object.values(object(path))) {
      const value = object(op);
      if (!value.operationId) continue;
      const route = app.routes.find((r) => r.hooks.detail?.operationId === value.operationId);
      // Elysia advertises form media by default; our TypeBox request bodies use JSON unless explicitly declared.
      if (route?.hooks.body && !route.hooks.detail?.requestBody) {
        value.requestBody = { required: true, content: { "application/json": { schema: route.hooks.body } } };
      }
      // Streaming routes document their success body in detail.responses; the plugin only serializes schema-map responses.
      const declared = object(route?.hooks.detail?.responses);
      if (Object.keys(declared).length > 0) value.responses = { ...object(value.responses), ...declared };
      const auth = value["x-backplane-auth"];
      value.security = [...(auth === "operator" ? [{ operatorToken: [] }] : []), ...(["principal", "either"].includes(String(auth)) ? [{ principalKey: [] }] : []),
        ...(["user", "either"].includes(String(auth)) ? [{ userSession: [] }] : [])];
      if (["required", "principal-required"].includes(String(value["x-backplane-run"]))) value.parameters = [...(Array.isArray(value.parameters) ? value.parameters : []),
        { in: "header", name: "x-backplane-run", required: value["x-backplane-run"] === "required", description: "Required for Principal callers.", schema: { type: "string", format: "uuid" } }];
    }
    const definitions: Record<string, unknown> = {};
    const collect = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(collect); return; }
      const schema = object(v);
      if (typeof schema.$id === "string") definitions[schema.$id] = schema;
      Object.values(schema).forEach(collect);
    };
    collect(doc);
    // TypeBox local recursive IDs become portable component references in the exported schema graph.
    const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v !== null && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "$id").map(([k, value]) => [k,
        k === "$ref" && typeof value === "string" && Object.hasOwn(definitions, value) ? `#/components/schemas/${value}` : normalize(value)])) : v;
    const normalized = object(normalize(doc)), components = object(normalized.components);
    normalized.components = { ...components, securitySchemes: { ...object(components.securitySchemes), operatorToken: { type: "http", scheme: "bearer" } }, schemas: { ...object(components.schemas), ...object(normalize(definitions)) } };
    commands(normalized);
    return stable(normalized);
  } finally { await pool.close(); }
}
