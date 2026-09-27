/**
 * The packager promisifies this hook and appends the completion callback after
 * (stagingPath, electronVersion, platform, arch), so the callback must be the
 * final parameter or the packaging step never resolves.
 */
export function dropRuntimeImageCache(
  buildPath: string,
  electronVersion: string,
  platform: string,
  arch: string,
  done: (error?: Error | null) => void,
): void;
