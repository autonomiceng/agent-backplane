import { expect, test } from "bun:test";
import { createPool } from "../platform/pool.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { adminUrl, migratedDatabase } from "../testing/postgres.ts";
import { createRun, issueKey, queueFixture } from "../testing/session.ts";
import type { Message } from "./send-message-input.ts";

// Sixth case justification: sibling test rule for the recovery endpoint.
test("recovery exceeds its batch limit, duplicates Deliveries or accepts a missing Run or foreign Workspace key", async () => {
  const url = await migratedDatabase();
  const pool = createPool(url);
  const admin = createPool(adminUrl(url));
  try {
    const { app, cookie, workspaceId, principalId, runId, queue, headers, messagesUrl } = await queueFixture(pool);
    const messageIds: string[] = [];
    for (let index = 0; index < 33; index++) {
      const sent = await app.handle(new Request(messagesUrl, {
        method: "POST", headers, body: JSON.stringify({ idempotencyKey: `legacy-${index}`, payload: { index } }),
      }));
      expect(sent.status).toBe(201);
      messageIds.push((await sent.json() as Message).id);
    }
    const [baseline] = await pool<{ position: string }[]>`
      SELECT max(position)::text AS position FROM audit.events WHERE workspace_id = ${workspaceId}`;
    if (!baseline) throw new Error("Audit cursor missing");
    // Removing initial Deliveries simulates Messages sent before the recovery migration.
    await withRunContext(admin, { workspaceId, principalId, runId }, async (tx) => {
      const deleted = await tx<{ id: string }[]>`
        DELETE FROM queue.deliveries WHERE workspace_id = ${workspaceId} AND queue = ${queue} RETURNING id`;
      expect(deleted).toHaveLength(33);
    });
    const recover = (actorHeaders: Record<string, string> = headers) => app.handle(new Request(
      `http://localhost/api/v1/workspaces/${workspaceId}/queues/${queue}/recover`, {
        method: "POST", headers: actorHeaders, body: "{}",
      },
    ));
    const missingRun = await recover({ authorization: headers.authorization, "content-type": "application/json" });
    expect(missingRun.status).toBe(400);

    const foreignWorkspaceResponse = await app.handle(new Request("http://localhost/api/v1/workspaces", {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Foreign Workspace" }),
    }));
    expect(foreignWorkspaceResponse.status).toBe(201);
    const foreignWorkspace = await foreignWorkspaceResponse.json() as { id: string };
    const foreignPrincipalResponse = await app.handle(new Request(`http://localhost/api/v1/workspaces/${foreignWorkspace.id}/principals`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "Foreign Principal" }),
    }));
    expect(foreignPrincipalResponse.status).toBe(201);
    const foreignPrincipal = await foreignPrincipalResponse.json() as { id: string };
    const foreignKey = await issueKey(app, cookie, foreignWorkspace.id, foreignPrincipal.id);
    const foreignRun = await createRun(app, foreignKey, foreignWorkspace.id);
    const foreign = await recover({ ...headers, authorization: `Bearer ${foreignKey}`, "x-backplane-run": foreignRun });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "workspace_forbidden" });

    const first = await recover();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ created: 32, hasMore: true });
    const second = await recover();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ created: 1, hasMore: false });
    const third = await recover();
    expect(third.status).toBe(200);
    expect(await third.json()).toEqual({ created: 0, hasMore: false });

    expect(await admin<{ messageId: string; count: number }[]>`
      SELECT message_id AS "messageId", count(*)::int AS count FROM queue.deliveries
      WHERE workspace_id = ${workspaceId} AND queue = ${queue} GROUP BY message_id ORDER BY message_id`)
      .toEqual(messageIds.toSorted().map((messageId) => ({ messageId, count: 1 })));
    const events = await pool<{ objects: string[]; principal_id: string; run_id: string }[]>`
      SELECT objects, principal_id, run_id FROM audit.events
      WHERE workspace_id = ${workspaceId} AND kind = 'queue.ready' AND position > ${baseline.position}::bigint`;
    expect(events).toHaveLength(33);
    expect(events.map((event) => event.objects[1]).sort()).toEqual(messageIds.toSorted());
    for (const event of events) expect(event).toMatchObject({ principal_id: principalId, run_id: runId });
  } finally {
    await pool.close();
    await admin.close();
  }
});
