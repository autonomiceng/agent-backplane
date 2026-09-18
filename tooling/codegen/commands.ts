// Contract validation and command descriptors shared by export and CLI generation.
export function object(value: unknown): Record<string, unknown> {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  return isObject(value) ? value : {};
}
export function kebab(value: string): string { return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(); }
export function stable(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, sort(x)])) : v;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}
export function declaration(value: unknown): void {
  const op = object(value);
  if (typeof op.operationId !== "string" || !op.operationId || !Array.isArray(op.tags) || typeof op.tags[0] !== "string" || !op.tags[0]
    || !["none", "principal", "user", "either", "operator"].includes(String(op["x-backplane-auth"]))
    || !["none", "required", "forbidden", "principal-required"].includes(String(op["x-backplane-run"]))) throw new Error("Operation missing contract declaration");
}
export function reference(document: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported reference: ${ref}`);
  const result = ref.slice(2).split("/").reduce<unknown>((v, k) => object(v)[decodeURIComponent(k).replaceAll("~1", "/").replaceAll("~0", "~")], document);
  if (result === undefined) throw new Error(`Unresolved reference: ${ref}`);
  return result;
}
export function commands(document: unknown) {
  const doc = object(document);
  const verify = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(verify); return; }
    const obj = object(value);
    if (typeof obj.$ref === "string") reference(doc, obj.$ref);
    Object.values(obj).forEach(verify);
  };
  verify(doc);
  const resolve = (value: unknown) => typeof object(value).$ref === "string" ? object(reference(doc, String(object(value).$ref))) : object(value);
  const empty = (value: unknown, seen: unknown[] = []): boolean => {
    if (value === false) return false;
    const s = resolve(value);
    if (seen.includes(s)) return false;
    const next = [...seen, s], isEmpty = (v: unknown) => empty(v, next);
    if (s.type !== undefined && !(Array.isArray(s.type) ? s.type.includes("object") : s.type === "object")) return false;
    if ((Array.isArray(s.required) && s.required.length > 0) || (typeof s.minProperties === "number" && s.minProperties > 0)) return false;
    if (s.const !== undefined && stable(s.const) !== stable({})) return false;
    if (Array.isArray(s.enum) && !s.enum.some((v) => stable(v) === stable({}))) return false;
    if (s.not !== undefined && isEmpty(s.not)) return false;
    if (Array.isArray(s.anyOf) && !s.anyOf.some(isEmpty)) return false;
    if (Array.isArray(s.oneOf) && s.oneOf.filter(isEmpty).length !== 1) return false;
    if (Array.isArray(s.allOf) && !s.allOf.every(isEmpty)) return false;
    return s.if === undefined || isEmpty(isEmpty(s.if) ? s.then : s.else);
  };
  const scalar = (s: Record<string, unknown>): boolean => ["string", "number", "integer", "boolean"].includes(String(s.type))
    || (Array.isArray(s.anyOf) && s.anyOf.every((v) => scalar(resolve(v)))) || (Array.isArray(s.oneOf) && s.oneOf.every((v) => scalar(resolve(v))));
  const names = new Set<string>();
  const schemas: Record<string, unknown> = { components: doc.components ?? {} };
  const result = Object.entries(object(doc.paths)).flatMap(([path, raw]) => Object.entries(object(raw)).flatMap(([method, value]) => {
    if (!["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(method)) return [];
    declaration(value);
    const op = object(value), operationId = String(op.operationId), tag = String(Array.isArray(op.tags) ? op.tags[0] : "");
    if (op["x-backplane-auth"] === "operator") return [];
    for (const [status, response] of Object.entries(object(op.responses))) {
      if (!/^2(?:[0-9]{2}|XX)$/.test(status)) continue;
      const media = Object.keys(object(resolve(response).content));
      if (status === "204" && !media.length) continue;
      if (method === "head" || status === "204" || status === "205" || !media.length || media.some((type) => !["application/json", "text/event-stream", "application/octet-stream"].includes(type))) {
        throw new Error(`Unsupported success response: ${operationId} (${status}); expected application/json, text/event-stream, application/octet-stream, or empty 204`);
      }
    }
    const request = resolve(op.requestBody), content = object(request.content);
    const media = Object.keys(content), contentType = media[0] ?? "application/json";
    if (op.requestBody !== undefined && (media.length !== 1 || !["application/json", "application/octet-stream"].includes(contentType))) throw new Error(`Unsupported body: ${operationId}`);
    const schema = object(content[contentType]).schema;
    const aliases = operationId === "releaseRestore" ? [["restore", "release"]] : operationId === "executeTransaction" ? [["transaction"]] : operationId === "createRun" ? [["run", "new"]] : operationId === "readAudit" ? [["events"]] : [];
    const command = [tag, kebab(operationId)];
    for (const name of [operationId, ...[command, ...aliases].map((a) => a.join(" "))]) {
      if (names.has(name)) throw new Error(`Command collision: ${name}`);
      names.add(name);
    }
    const inherited = object(raw).parameters;
    const params = [...(Array.isArray(inherited) ? inherited : []), ...(Array.isArray(op.parameters) ? op.parameters : [])];
    const parameters = params.map((v) => {
      const p = resolve(v), schema = resolve(p.schema), location = String(p.in), name = String(p.name);
      if (location === "header" && name.toLowerCase() === "x-backplane-run") return null;
      if (!["path", "query", "header"].includes(location) || !scalar(schema)
        || (p.style !== undefined && p.style !== (location === "query" ? "form" : "simple")) || p.content !== undefined || p.allowReserved === true) throw new Error(`Unsupported parameter: ${operationId}.${name}`);
      return { in: location, name, flag: kebab(name), required: p.required === true, schema };
    }).filter((p) => p !== null);
    const flags = parameters.map((p) => p.flag);
    if (new Set(flags).size !== flags.length || flags.some((f) => ["body", "help", "follow", "file", "out", "force"].includes(f) || f === "authorization")) throw new Error(`Flag collision: ${operationId}`);
    schemas[`${operationId}.request`] = request;
    schemas[`${operationId}.responses`] = op.responses;
    return [{ operationId, command, aliases, method: method.toUpperCase(), path, auth: String(op["x-backplane-auth"]), run: op["x-backplane-run"] === "principal-required" ? "required" : String(op["x-backplane-run"]), parameters,
      body: schema === undefined ? null : { required: request.required === true, contentType, empty: contentType === "application/json" && empty(schema), schemaRef: `${operationId}.request` },
      binary: Object.entries(object(op.responses)).some(([status, r]) => status.startsWith("2") && "application/octet-stream" in object(resolve(r).content)),
      responsesRef: `${operationId}.responses`, stream: Object.values(object(op.responses)).some((r) => "text/event-stream" in object(resolve(r).content)) }];
  }));
  return { commands: result, schemas };
}
export type Command = ReturnType<typeof commands>["commands"][number];

export function tools(document: unknown) {
  const artifacts = commands(document);
  const portable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(portable);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key !== "$ref") return [key, portable(item)];
      if (typeof item !== "string" ||
          !item.startsWith("#/components/schemas/"))
        throw new Error("Unsupported MCP schema reference");
      return [key, item.replace("#/components/schemas/", "#/$defs/")];
    }));
  };
  return artifacts.commands.filter((command) => command.auth !== "user").map((command) => {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(command.operationId))
      throw new Error("Invalid MCP tool name");
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const parameter of command.parameters) {
      if (Object.hasOwn(properties, parameter.name))
        throw new Error("MCP parameter collision");
      properties[parameter.name] = parameter.schema;
      if (parameter.required && parameter.name !== "workspaceId") required.push(parameter.name);
    }
    if (command.body) {
      const name = command.body.contentType === "application/octet-stream" ? "file" : "body";
      if (Object.hasOwn(properties, name))
        throw new Error("MCP body collision");
      const request = object(artifacts.schemas[command.body.schemaRef]);
      properties[name] = name === "file" ? { type: "string", description: "Local-only path read by the MCP server process; stdin is unavailable." }
        : object(object(request.content)["application/json"]).schema;
      if (command.body.required) required.push(name);
    }
    const definitions: Record<string, unknown> = {};
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(collect); return; }
      const schema = object(value);
      if (typeof schema.$ref === "string") {
        if (!schema.$ref.startsWith("#/components/schemas/")) throw new Error("Unsupported MCP schema reference");
        const name = decodeURIComponent(schema.$ref.split("/")[3] ?? "").replaceAll("~1", "/").replaceAll("~0", "~");
        if (!Object.hasOwn(definitions, name)) {
          definitions[name] = object(object(artifacts.schemas.components).schemas)[name];
          collect(definitions[name]);
        }
      }
      Object.values(schema).forEach(collect);
    };
    collect(properties);
    return {
      name: command.operationId,
      description: `${command.method} ${command.path}${command.binary ? "; returns base64 content, at most 4 MiB" : ""}${command.stream ? "; collects at most one second or 100 frames, then aborts and returns an array" : ""}`,
      command,
      inputSchema: portable({
        type: "object", properties, required,
        additionalProperties: false,
        $defs: definitions,
      }),
    };
  });
}
