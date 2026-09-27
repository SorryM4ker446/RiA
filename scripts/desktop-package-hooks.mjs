import { rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Next.js writes optimized images into <runtime>/.next/cache using a filename
 * derived from a hash of the request. That name reaches roughly 200 characters
 * relative to the app root, and the Squirrel maker copies the packaged app into
 * a temporary directory before running nuget, which re-roots it under
 * %TEMP%\squirrel-maker-XXXXXX\. On a runner the combined length crosses the
 * 260-character Windows limit and nuget fails with "the fully qualified file
 * name must be less than 260 characters".
 *
 * The cache is a regenerable runtime artifact and never part of the shipped
 * bundle, so it is dropped from the staged copy. Without this the installer step
 * fails on CI while passing locally, because the two temp roots differ in length.
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
