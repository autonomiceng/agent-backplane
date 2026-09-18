// SSE responses become one JSON line per data frame; heartbeats carry no output.
export async function events(response: Response, write: (text: string) => void, signal?: AbortSignal): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let pending = "", id = "", event = "message", data: string[] = [];
  const line = (text: string) => {
    if (!text) {
      if (data.length && event !== "heartbeat") { const raw = data.join("\n"); let value: unknown; try { value = JSON.parse(raw); } catch { value = raw; } write(`${JSON.stringify({ id, event, data: value })}\n`); }
      event = "message"; data = []; return;
    }
    const colon = text.indexOf(":"), field = colon < 0 ? text : text.slice(0, colon), value = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (field === "id" && !value.includes("\0")) id = value;
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  };
  try {
    while (!signal?.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) { line(pending.slice(0, newline).replace(/\r$/, "")); pending = pending.slice(newline + 1); }
    }
  } catch (error) {
    // A caller-initiated abort ends the follow cleanly; any other read failure still surfaces.
    if (!signal?.aborted) throw error;
  } finally { signal?.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
