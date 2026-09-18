import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Repository migrations for the protected schemas. Forward-only, applied in filename order (ADR-0015).
export type Migration = { version: number; name: string; sql: string };
export type AppliedMigration = { version: number; name: string };

const FILE = /^(\d{6})_([a-z0-9_]+)\.sql$/;

export class MigrationError extends Error {}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const entries = await readdir(dir);
  for (const name of entries) {
    if (/\.sql$/i.test(name) && !FILE.test(name)) throw new MigrationError(`invalid migration filename ${name}`);
  }
  const names = entries.filter((name) => FILE.test(name)).sort();
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

// Validate the whole repository and ledger before applying any forward migration.
export function migrate(runner: MigrationRunner, migrations: Migration[]): Promise<number[]> {
  return runner.locked(async (session) => {
    const repository = new Map<number, string>();
    let previous = 0;
    for (const m of migrations) {
      if (!Number.isSafeInteger(m.version) || m.version <= previous || m.version > 999999
        || !/^[a-z0-9_]+$/.test(m.name)) throw new MigrationError(`invalid or unordered migration ${m.version}: ${m.name}`);
      repository.set(m.version, m.name);
      previous = m.version;
    }
    const done = new Map<number, string>();
    let highest = 0;
    for (const recorded of await session.applied()) {
      if (done.has(recorded.version)) throw new MigrationError(`duplicate recorded migration ${recorded.version}`);
      const name = repository.get(recorded.version);
      if (name === undefined) throw new MigrationError(`recorded migration ${recorded.version} is missing from repository`);
      if (name !== recorded.name) throw new MigrationError(`migration ${recorded.version} recorded as ${recorded.name}, repository has ${name}`);
      done.set(recorded.version, recorded.name);
      highest = Math.max(highest, recorded.version);
    }
    for (const m of migrations) {
      if (!done.has(m.version) && m.version <= highest) throw new MigrationError(`migration ${m.version} is below recorded high-water mark ${highest}`);
    }
    const applied: number[] = [];
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      await session.apply(m);
      applied.push(m.version);
    }
    return applied;
  });
}
