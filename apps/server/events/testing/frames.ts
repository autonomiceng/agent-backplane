import type { AuditPage } from "../read-audit-input.ts";

export async function* frames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let primaryError = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      buffered += decoder.decode(next.value, { stream: true });
      let end: number;
      while ((end = buffered.indexOf("\n\n")) >= 0) {
        const frame = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        const lines = frame.split("\n");
        yield { event: lines.find((line) => line.startsWith("event: "))?.slice(7),
          id: lines.find((line) => line.startsWith("id: "))?.slice(4),
          data: JSON.parse(lines.find((line) => line.startsWith("data: "))?.slice(6) ?? "null") as
            AuditPage["events"][number] & { head: string; generation: string; after: string } };
      }
    }
  } catch (error) { primaryError = true; throw error; }
  finally {
    try { await reader.cancel(); } catch (error) { if (!primaryError) throw error; }
    finally { reader.releaseLock(); }
  }
}

export async function nextFrame(stream: ReturnType<typeof frames>) {
  const next = await stream.next();
  if (next.done) throw new Error("stream ended before the expected frame");
  return next.value;
}

