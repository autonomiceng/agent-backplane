// Applies pending repository migrations. Run before the server starts; exits non-zero on failure.
import { SQL } from "bun";
import { loadMigrations, migrate } from "./migrations.ts";
import { sqlMigrationRunner } from "./sql-migration-runner.ts";

const adminDatabaseUrl = Bun.env.BP_ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) throw new Error("BP_ADMIN_DATABASE_URL is required for migrations");
const sql = new SQL({ url: adminDatabaseUrl, max: 1 });
try {
  const applied = await migrate(sqlMigrationRunner(sql), await loadMigrations(new URL("./migrations", import.meta.url).pathname));
  console.log(applied.length ? `applied migrations ${applied.join(", ")}` : "migrations up to date");
} finally {
  await sql.close();
}
