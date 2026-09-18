import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { migratedDatabase } from "../testing/postgres.ts";
import { validateStreamCursor } from "./stream-audit-input.ts";
import { principalFixture } from "../testing/session.ts";

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected fixture value");
  return value;
}

test("expired, foreign, malformed, or overflow cursors silently start a fresh subscription", async () => {
  const pool = createPool(await migratedDatabase());
  try {
    const { app, cookie, workspaceId } = await principalFixture(pool);
    const url = `http://localhost/api/v1/workspaces/${workspaceId}/events`;
    const open = (query = "", lastEventId?: string) => app.handle(new Request(`${url}${query}`, {
      headers: { cookie, ...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }) },
    }));
    const bootstrap = await open();
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const reader = must(bootstrap.body).getReader();
    const ready = new TextDecoder().decode((await reader.read()).value);
    expect(ready).toStartWith("event: ready\n");
    const state = JSON.parse(must(must(ready.split("data: ")[1]).split("\n")[0])) as {
      generation: string; head: string; retentionFloor: string; after: string;
    };
    expect(state).toMatchObject({ after: "0", retentionFloor: "0" });
    await reader.cancel();
    const id = `v1:${workspaceId}:${state.generation}:${state.head}`;
    const unknown = crypto.randomUUID();
    const expired = { error: "cursor_expired", resync: true, generation: state.generation, head: state.head, retentionFloor: "0" };
    expect(validateStreamCursor({ after: "0", generation: state.generation }, workspaceId,
      { generation: state.generation, head: state.head, retentionFloor: "1" })).toEqual({ error: "cursor_expired", resync: true, generation: state.generation, head: state.head, retentionFloor: "1" });
    const wrongGeneration = await open(`?generation=${unknown}`);
    expect(wrongGeneration.status).toBe(409);
    expect(await wrongGeneration.json()).toEqual(expired);
    const foreign = await open("", `v1:${crypto.randomUUID()}:${state.generation}:0`);
    expect(foreign.status).toBe(409);
    expect(await foreign.json()).toEqual(expired);
    const aboveHead = await open(`?since=${BigInt(state.head) + 1n}&generation=${state.generation}`);
    expect(aboveHead.status).toBe(409);
    expect(await aboveHead.json()).toEqual(expired);
    const malformed = await open("?since=-1");
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toEqual({ error: "invalid_input" });
    const overflow = await open(`?since=9223372036854775808&generation=${state.generation}`);
    expect(overflow.status).toBe(422);
    const noncanonical = await open("?since=00");
    expect(noncanonical.status).toBe(422);
    const trailingNewline = await open(`?since=0%0A&generation=${state.generation}`);
    expect(trailingNewline.status).toBe(422);
    const missingGeneration = await open(`?since=${state.head}`);
    expect(missingGeneration.status).toBe(422);
    const emptyHeader = await open(`?generation=${state.generation}`, "");
    expect(emptyHeader.status).toBe(422);
    const unknownQuery = await open("?limit=1", id);
    expect(unknownQuery.status).toBe(422);
    const precedence = await open("?since=broken&generation=broken", id);
    expect(precedence.status).toBe(200);
    const resumed = must(precedence.body).getReader();
    const resumedReady = new TextDecoder().decode((await resumed.read()).value);
    expect(resumedReady).toContain(`id: ${id}\n`);
    expect(resumedReady).toContain(`"after":"${state.head}"`);
    await resumed.cancel();
    const head = await open(`?since=${state.head}&generation=${state.generation}`);
    expect(head.status).toBe(200);
    await must(head.body).cancel();
    const zero = await open("?since=0");
    expect(zero.status).toBe(200);
    await must(zero.body).cancel();
  } finally { await pool.close(); }
});
