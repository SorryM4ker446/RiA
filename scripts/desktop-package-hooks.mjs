import { rmSync } from "node:fs";
import { join } from "node:path";

export const runtimeCacheDirectories = [join(".next", "cache"), join(".next", "server", "route-cache")];

/**
 * Image caches and scoped response caches are regenerable runtime artifacts.
 * Next.js without a build adapter retains immutable response seeds under
 * server/app and server/pages; those files and their metadata must stay intact.
 * Exclude runtime copies, whose hashed paths can exceed the Windows path budget.
 *
 * The packager promisifies this hook and appends the completion callback after
 * (stagingPath, electronVersion, platform, arch), so the callback must be the
 * final parameter or the packaging step never resolves.
 */
export function dropRuntimeCaches(buildPath, _electronVersion, _platform, _arch, done) {
  for (const directory of runtimeCacheDirectories) {
    rmSync(join(buildPath, "resources", ".desktop-runtime", directory), {
      recursive: true,
      force: true,
    });
  }
  done();
}
