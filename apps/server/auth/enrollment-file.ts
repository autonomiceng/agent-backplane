// Startup publishes the local capability; only a committed enrollment may remove it.
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
export function capabilityPath(dataDir: string): string { return join(resolve(dataDir), "enrollment", "capability"); }
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function validateAncestors(dir: string, allowMissing = false): Promise<void> {
  for (let ancestor = dir; ; ancestor = dirname(ancestor)) {
    const stat = await lstat(ancestor).catch((error: unknown) => {
      if (allowMissing && error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error;
    });
    if (!stat) continue;
    if (stat.uid !== process.getuid?.() && stat.uid !== 0) throw new Error("unsafe_enrollment_directory");
    if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000))) throw new Error("unsafe_enrollment_directory");
    if (ancestor === dir && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)) throw new Error("unsafe_enrollment_directory");
    if (ancestor === dirname(ancestor)) break;
  }
}
export async function enrollmentFile(path: string, published?: () => Promise<void>): Promise<string> {
  const dir = dirname(path);
  await validateAncestors(dir, true);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await validateAncestors(dir);
  const existing = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null; throw error;
  });
  const file = await open(path, constants.O_NOFOLLOW | constants.O_NONBLOCK | (existing ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL), 0o600);
  try {
    await validateAncestors(dir);
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 64) throw new Error("unsafe_enrollment_file");
    if (existing) {
      const value = await file.readFile("utf8");
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid_enrollment_file");
      await file.sync(); await syncDirectory(dir); await syncDirectory(dirname(dir));
      return value;
    }
    await published?.();
    await validateAncestors(dir);
    const value = randomBytes(32).toString("hex");
    await file.writeFile(value); await file.sync();
    await syncDirectory(dir); await syncDirectory(dirname(dir));
    return value;
  } finally { await file.close(); }
}
export async function removeEnrollmentFile(path: string): Promise<void> {
  await unlink(path); await syncDirectory(dirname(path));
}
