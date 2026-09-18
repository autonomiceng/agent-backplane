import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MigrationError, loadMigrations, migrate, type Migration, type MigrationRunner } from "./migrations.ts";

const m = (version: number, name = `m${version}`): Migration => ({ version, name, sql: "" });

function fakeRunner(recorded: { version: number; name: string }[]): MigrationRunner & { applied: number[] } {
  const applied: number[] = [];
  return {
    applied,
    locked: (fn) => fn({ applied: async () => recorded, apply: async (x) => void applied.push(x.version) }),
  };
}

describe("migrate", () => {
  test("applies only versions not yet recorded, in order", async () => {
    const runner = fakeRunner([{ version: 1, name: "m1" }]);
    expect(await migrate(runner, [m(1), m(2), m(3)])).toEqual([2, 3]);
    expect(runner.applied).toEqual([2, 3]);
  });

  test("a recorded version with a different name is a corrupted ledger, not a skip", async () => {
    const runner = fakeRunner([{ version: 1, name: "other" }]);
    await expect(migrate(runner, [m(1)])).rejects.toBeInstanceOf(MigrationError);
    expect(runner.applied).toEqual([]);
  });
});

describe("loadMigrations", () => {
  test("reads the repository migrations in version order", async () => {
    const list = await loadMigrations(new URL("./migrations", import.meta.url).pathname);
    expect(list[0]).toMatchObject({ version: 1, name: "protected_schemas" });
    expect(list.map((x) => x.version)).toEqual(list.map((x) => x.version).toSorted((a, b) => a - b));
  });

  test("two files sharing a version number are rejected before any SQL runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bp-mig-"));
    try {
      await writeFile(join(dir, "000001_a.sql"), "");
      await writeFile(join(dir, "000001_b.sql"), "");
      await expect(loadMigrations(dir)).rejects.toBeInstanceOf(MigrationError);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// Discovery and ledger validation must fail before any migration writes.
test("malformed SQL filenames cannot silently disappear", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bp-mig-invalid-"));
  try {
    await writeFile(join(dir, "README.md"), "ordinary documentation");
    expect(await loadMigrations(dir)).toEqual([]);
    for (const name of ["00031_thing.sql", "000031_Thing.sql", "000031-thing.sql", "000031_thing.SQL"]) {
      await writeFile(join(dir, name), "SELECT 1;");
      await expect(loadMigrations(dir)).rejects.toBeInstanceOf(MigrationError);
      await rm(join(dir, name));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("retroactive, missing and reordered migrations fail before writes", async () => {
  for (const [recorded, pending] of [
    [[m(3)], [m(1), m(2), m(3)]], [[m(4)], [m(1), m(2)]],
    [[m(2, "different")], [m(1), m(2)]], [[], [m(2), m(1)]], [[], [m(1), m(1)]],
  ] satisfies [Migration[], Migration[]][]) {
    const runner = fakeRunner(recorded);
    await expect(migrate(runner, pending)).rejects.toBeInstanceOf(MigrationError);
    expect(runner.applied).toEqual([]);
  }
});
