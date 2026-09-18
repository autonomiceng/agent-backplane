// Restricted executable skill grammar; no shell is invoked by the integration test.
import { record } from "../../cli/runtime/http.ts";
export function examples(markdown: string) {
  const result = [];
  for (const match of markdown.matchAll(/```bash\n([\s\S]*?)```/g)) {
    const lines = (match[1] ?? "").trimEnd().split("\n"), marker = lines.shift() ?? "";
    const parsed = /^# bp-example ([\w.-]+)(?: capture=([A-Z_]+:\/[^ ]+(?:,[A-Z_]+:\/[^ ]+)*))?(?: fixture=(ambiguous))?$/.exec(marker);
    if (!parsed) throw new Error("Unsupported example marker");
    result.push({ name: parsed[1] ?? "", captures: (parsed[2] ?? "").split(",").filter(Boolean), fixture: parsed[3], lines });
  }
  if (!result.length) throw new Error("No executable examples");
  return result;
}
function substitute(text: string, bindings: Record<string, string>): string {
  if (/\$(?![A-Z_][A-Z_0-9]*(?![A-Za-z0-9_]))/.test(text)) throw new Error("Unsupported variable syntax");
  return text.replace(/\$([A-Z_][A-Z_0-9]*)/g, (_, name: string) => {
    if (!Object.hasOwn(bindings, name)) throw new Error(`Missing binding: ${name}`);
    return bindings[name] ?? "";
  });
}
export function commandsForExample(example: ReturnType<typeof examples>[number], bindings: Record<string, string>) {
  const result = [];
  for (let i = 0; i < example.lines.length; i++) {
    const line = example.lines[i] ?? "";
    const heredoc = / <<('JSON'|JSON)$/.exec(line), command = heredoc ? line.slice(0, heredoc.index) : line;
    const tokens: string[] = [];
    const pattern = /\s*("(?:[^"\\]|\\["\\])*"|'[^']*'|[^\s"'\\]+)\s*/gy;
    let offset = 0;
    while (offset < command.length) {
      pattern.lastIndex = offset;
      const match = pattern.exec(command);
      if (!match) throw new Error("Unsupported quoting");
      const raw = match[1] ?? "";
      if (!raw.startsWith("'") && !raw.startsWith('"') && /[;`|&<>\n*?()[\]{}]/.test(raw)) throw new Error("Unsupported shell syntax");
      if (!raw.startsWith("'") && /`|\$[({]/.test(raw)) throw new Error("Unsupported expansion");
      tokens.push(raw.startsWith("'") ? raw.slice(1, -1) : substitute(raw.startsWith('"') ? JSON.parse(raw) : raw, bindings));
      offset = pattern.lastIndex;
    }
    if (tokens.shift() !== "bp") throw new Error("Expected bp command");
    let body = "";
    if (heredoc) {
      const rows = [];
      while (++i < example.lines.length && example.lines[i] !== "JSON") rows.push(example.lines[i]);
      if (i === example.lines.length) throw new Error("Unterminated heredoc");
      body = rows.join("\n") + "\n";
      if (heredoc[1] === "JSON") {
        if (/`|\$(?![A-Z_])|\\/.test(body)) throw new Error("Unsupported heredoc expansion");
        body = substitute(body, bindings);
      }
    }
    result.push({ argv: tokens, body });
  }
  return result;
}
export function capture(example: ReturnType<typeof examples>[number], value: unknown, bindings: Record<string, string>): void {
  for (const binding of example.captures) {
    const [name, pointer] = binding.split(":");
    let selected = value;
    for (const key of (pointer ?? "").slice(1).split("/")) selected = record(selected) ? selected[key.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined;
    if (!name || typeof selected !== "string") throw new Error("Invalid capture");
    bindings[name] = selected;
  }
}
