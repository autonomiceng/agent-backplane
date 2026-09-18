import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Repository migrations for the protected schemas. Forward-only, applied in filename order (ADR-0015).
export type Migration = { version: number; name: string; sql: string };
export type AppliedMigration = { version: number; name: string };

const FILE = /^(\d{6})_([a-z0-9_]+)\.sql$/;

export class MigrationError extends Error {}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const names = (await readdir(dir)).filter((n) => FILE.test(n)).sort();
  const list = await Promise.all(
    names.map(async (n) => {
      const match = n.match(FILE)!;
      return { version: Number(match[1]), name: match[2]!, sql: await Bun.file(join(dir, n)).text() };
    }),
  );
  const seen = new Set<number>();
  for (const m of list) {
    if (seen.has(m.version)) throw new MigrationError(`duplicate migration version ${m.version}`);
    seen.add(m.version);
  }
  return list;
}

// One serialized migration session: the adapter holds an exclusive lock for the whole call.
export type MigrationSession = {
  applied(): Promise<AppliedMigration[]>;
  apply(migration: Migration): Promise<void>;
};
export type MigrationRunner = { locked<T>(fn: (session: MigrationSession) => Promise<T>): Promise<T> };

// Applies every migration not yet recorded and returns their versions.
// A recorded version whose name differs from the repository file is a corrupted ledger, never skipped silently.
export function migrate(runner: MigrationRunner, migrations: Migration[]): Promise<number[]> {
  return runner.locked(async (session) => {
    const done = new Map((await session.applied()).map((a) => [a.version, a.name]));
    const applied: number[] = [];
    for (const m of migrations) {
      const recorded = done.get(m.version);
      if (recorded === m.name) continue;
      if (recorded !== undefined) {
        throw new MigrationError(`migration ${m.version} recorded as ${recorded}, repository has ${m.name}`);
      }
      await session.apply(m);
      applied.push(m.version);
    }
    return applied;
  });
}
