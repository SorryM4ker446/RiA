import { rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Optimized image caches are regenerable user/runtime artifacts. Their hashed
 * filenames can also exceed the Windows path budget after installation, so
 * exclude them from the staged bundle.
 *
 * The packager promisifies this hook and appends the completion callback after
 * (stagingPath, electronVersion, platform, arch), so the callback must be the
 * final parameter or the packaging step never resolves.
 */
export function dropRuntimeImageCache(buildPath, _electronVersion, _platform, _arch, done) {
  rmSync(join(buildPath, "resources", ".desktop-runtime", ".next", "cache"), {
    recursive: true,
    force: true,
  });
  done();
}
