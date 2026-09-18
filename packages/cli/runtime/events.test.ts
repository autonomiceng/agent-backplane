import { expect, test } from "bun:test";
import { events } from "./events.ts";

test("named heartbeat frames produce no CLI output and preserve the audit cursor", async () => {
  const output: string[] = [];
  const bytes = new TextEncoder().encode('event: ready\ndata: {}\n\nid: 7\nevent: audit\ndata: {"position":"7"}\n\nevent: heartbeat\ndata: {}\n\nevent: audit\ndata: {"position":"8"}\n\n');
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.slice(offset, offset + 3));
    controller.close();
  } });
  await events(new Response(stream), text => { output.push(text); });
  expect(output.map(line => JSON.parse(line))).toEqual([
    { id: "", event: "ready", data: {} },
    { id: "7", event: "audit", data: { position: "7" } },
    { id: "7", event: "audit", data: { position: "8" } },
  ]);
});
