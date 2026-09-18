// Setup only for deliberately invalid contracts in adversarial tests, including foreign-Workspace relations.
// Valid tables use testing/session.ts applyMigration; fixture data still goes through POST /sql.
import { installContract, verifyContract } from "../schema/workspace-contract.ts";
import { withRunContext } from "../runs/with-run-context.ts";
import { SQL } from "bun";
import { adminUrl } from "./postgres.ts";

export async function workspaceTable(url: string, workspaceId: string, ddl: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(workspaceId)) throw new Error("invalid workspace id");
  const match = /^CREATE TABLE ([a-z_][a-z0-9_]*)\s*\(/i.exec(ddl);
  if (!match?.[1]) throw new Error("fixture requires CREATE TABLE with an unqualified identifier");
  const schema = `ws_${workspaceId.replaceAll("-", "")}`;
  const group = `bp_ws_${workspaceId.replaceAll("-", "")}`;
  const table = match[1].toLowerCase();
  const admin = new SQL({ url: adminUrl(url), max: 1 });
  try {
    const [actor] = await admin<{ principal_id: string | null; run_id: string | null; user_id: string | null }[]>`
      SELECT principal_id, run_id, user_id FROM audit.events WHERE workspace_id = ${workspaceId} ORDER BY position DESC LIMIT 1`;
    if (!actor) throw new Error("fixture requires a Workspace actor");
    const context = actor.principal_id && actor.run_id
      ? { workspaceId, principalId: actor.principal_id, runId: actor.run_id }
      : { workspaceId, userId: actor.user_id ?? "" };
    await withRunContext(admin, context, async (tx) => {
      await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}" AUTHORIZATION bp_executor`);
      const [role] = await tx`SELECT 1 FROM pg_roles WHERE rolname = ${group}`;
      if (!role) {
        await tx.unsafe(`CREATE ROLE "${group}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
        await tx.unsafe(`GRANT "${group}" TO bp_provisioner WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
      }
      await tx.unsafe(`SET LOCAL ROLE bp_executor`);
      await tx.unsafe(`SET LOCAL search_path = "${schema}"`);
      await tx.unsafe(ddl);
      await tx.unsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${group}"`);
      await installContract(tx, schema, table);
      await verifyContract(tx, schema);
    });
  } finally { await admin.close(); }
}
