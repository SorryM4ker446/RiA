import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { join } from "node:path";

/**
 * Creates an isolated temporary directory and returns a disposer that refuses
 * to delete anything outside the operating-system temp directory. Tests that
 * touch workspaces must never be able to delete real user data.
 */
export function createTempDirectory(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const remove = () => removeTempDirectory(root, prefix);
  return { root, remove };
}

/**
 * Removes a test directory, retrying briefly because Windows can hold a
 * directory busy for a moment after a database handle closes. The guard keeps
 * the deletion inside the temp directory even when a test passes its own path.
 */
export function removeTempDirectory(root, prefix) {
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith(prefix)) {
    throw new Error(`Refusing to remove an unexpected directory: ${root}`);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/**
 * Teardown helper for tests that manage their own directory. Only the parent
 * directory is checked, and a still-busy directory is reported instead of
 * failing an otherwise passing test.
 */
export function removeTempDirectoryQuietly(root) {
  if (dirname(root) !== resolve(tmpdir())) {
    throw new Error(`Refusing to remove a directory outside the temp directory: ${root}`);
  }
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (error) {
    process.emitWarning(`Could not remove temporary test directory ${root}: ${error.message}`);
  }
}
