// Registration accepts one prebundled UTF-8 ES module and a bounded egress allowlist.
import { t } from "elysia";
export const deployFunctionInput = t.Object({ id: t.String({ format: "uuid" }), bundle: t.String({ minLength: 1 }),
  entryPoint: t.Literal("default"), outboundUrls: t.Array(t.String({ maxLength: 2048 }), { maxItems: 16 }) }, { additionalProperties: false });
