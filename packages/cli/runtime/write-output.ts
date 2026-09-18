// Binary downloads publish a completed private temporary file; replacement requires an explicit force flag.
import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CliError } from "./credentials.ts";
export async function writeOutput(destination: string, bytes: Uint8Array, force = false): Promise<void> {
  const path = resolve(destination), temporary = join(dirname(path), `.bp-download-${crypto.randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  let reservation;
  try {
    await file.writeFile(bytes); await file.sync(); await file.close();
    if (force) {
      const existing = await lstat(path).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      });
      if (existing?.isSymbolicLink()) throw new CliError("output_symlink");
    } else {
      try { reservation = await open(path, "wx", 0o600); }
      catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new CliError("output_exists");
        throw error;
      }
    }
    await rename(temporary, path);
  } finally {
    await file.close();
    if (reservation) {
      const owned = await reservation.stat(), current = await lstat(path).catch(() => null);
      await reservation.close();
      if (current?.ino === owned.ino && current.dev === owned.dev) await unlink(path);
    }
    await unlink(temporary).catch(() => {});
  }
}
