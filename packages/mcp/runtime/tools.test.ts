import { expect, test } from "bun:test";
import contract from "../../../contracts/openapi/openapi.json";
import descriptors from "../../cli/generated/commands.json";
import { commands, tools, object } from "../../../tooling/codegen/commands.ts";
import { argumentsForTool, catalog } from "./tools.ts";
import { execute } from "../../cli/runtime/execute.ts";

test("Generated tools lose schemas, expose User operations, or alter CLI arguments", async () => {
  // The CLI now carries User commands behind bp login; MCP still serves Principal-capable operations only.
  expect(catalog.map((t) => t.name)).toEqual(descriptors.filter((c) => c.auth !== "user").map((c) => c.operationId));
  expect<unknown>(catalog).toEqual(tools(contract));
  const operation = { operationId: "probe", tags: ["test"], "x-backplane-auth": "principal", "x-backplane-run": "principal-required",
    parameters: [{ in: "path", name: "workspaceId", schema: { type: "string" }, required: true }, { in: "query", name: "text", schema: { type: "string" }, required: true },
      { in: "query", name: "count", schema: { type: "integer" } }, { in: "query", name: "enabled", schema: { type: "boolean" } }],
    requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Node~1item" } } } } };
  const document = { paths: { "/test": { post: operation }, "/user": { post: { ...operation, operationId: "user", "x-backplane-auth": "user" } } },
    components: { schemas: { "Node/item": { type: "object", properties: {
      next: { $ref: "#/components/schemas/Node~1item" }, child: { $ref: "#/components/schemas/Leaf" },
    } }, Leaf: { type: "string" }, Unused: { type: "number" } } } };
  const [tool] = tools(document);
  expect(tools(document)).toHaveLength(1);
  expect(tool?.command.run).toBe("required");
  expect(object(tool?.inputSchema).required).toEqual(["text", "body"]);
  expect(object(object(tool?.inputSchema).properties).body).toEqual({ $ref: "#/$defs/Node~1item" });
  expect(object(tool?.inputSchema).$defs).toEqual({ "Node/item": { type: "object", properties: {
    next: { $ref: "#/$defs/Node~1item" }, child: { $ref: "#/$defs/Leaf" },
  } }, Leaf: { type: "string" } });
  expect(object(object(tool?.inputSchema).properties).workspaceId).toEqual({ type: "string" });
  const scalarOnly = tools({ ...document, paths: { "/scalar": { get: {
    operationId: "scalar", tags: ["test"], "x-backplane-auth": "none", "x-backplane-run": "none",
  } } } })[0]!;
  expect(object(scalarOnly.inputSchema).$defs).toEqual({});
  let help = "";
  expect(await execute(["transaction", "--help"], { env: {}, stdin: async () => "", stdout: (text) => { help += text; },
    stderr: () => { throw new Error("Help failed"); } })).toBe(0);
  const described = JSON.parse(help);
  expect(described.requestSchema.required).toContain("operations");
  expect(described.requestSchema.properties.operations.items.anyOf[0].properties.sql.properties.statement).toMatchObject({ type: "string" });
  expect(described.components.schemas).toBeDefined();
  const command = commands(document).commands[0]!;
  const body = { next: null, literal: '"\\\n$HOME' };
  expect(argumentsForTool(command, { text: '--help & "$(echo secret)" café', count: 2, enabled: false, body })).toEqual({
    argv: ["test", "probe", '--text=--help & "$(echo secret)" café', "--count=2", "--enabled=false", "--body", "-"], body: JSON.stringify(body),
  });
  expect(() => argumentsForTool(command, { authorization: "secret" })).toThrow();
  expect(() => tools({ ...document, paths: { "/test": { post: { ...operation,
    parameters: [...operation.parameters, { in: "path", name: "text", schema: { type: "string" } }] } } } })).toThrow();
  expect(() => tools({ ...document, paths: { "/test": { post: { ...operation,
    parameters: [{ in: "query", name: "body", schema: { type: "string" } }] } } } })).toThrow();
});
