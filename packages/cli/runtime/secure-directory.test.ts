// Pure policy coverage adds one millisecond-scale case beyond the two Postgres scenarios.
import { expect, test } from "bun:test";
import { assertSecureDirectory } from "./secure-directory.ts";

test("secure directories accept symlinks, non-directories or a foreign final owner", () => {
  const directory = { isDirectory: () => true, isSymbolicLink: () => false, uid: 1000 };
  expect(() => assertSecureDirectory(directory, 1000)).not.toThrow();
  expect(() => assertSecureDirectory({ ...directory, uid: 0 })).not.toThrow();
  expect(() => assertSecureDirectory({ ...directory, isSymbolicLink: () => true }, 1000)).toThrow("unsafe_cache_directory");
  expect(() => assertSecureDirectory({ ...directory, isDirectory: () => false }, 1000)).toThrow("unsafe_cache_directory");
  expect(() => assertSecureDirectory(directory, 1001)).toThrow("unsafe_cache_owner");
});
