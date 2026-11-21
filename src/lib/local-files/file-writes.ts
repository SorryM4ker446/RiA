import { constants } from "node:fs";
import { copyFile, link, rm } from "node:fs/promises";

/*
 * Writes RiA makes to workspace files: the file tool's edits and undo/redo.
 * They take turns per file through one lock, so two of them never interleave
 * between checking a file and writing it. Programs outside RiA are not held by
 * it; each writer still checks the file just before it writes.
 */

type Locks = Map<string, Promise<unknown>>;
const locks = (): Locks => ((globalThis as { __riaFileWriteLocks?: Locks }).__riaFileWriteLocks ??= new Map());
const keyOf = (absolutePath: string) => (process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath);

/** Runs work once every earlier RiA write to the same file has finished. */
export async function withFileWriteLock<T>(absolutePath: string, work: () => Promise<T>): Promise<T> {
  const key = keyOf(absolutePath);
  const previous = locks().get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(work);
  locks().set(key, run);
  try { return await run; } finally { if (locks().get(key) === run) locks().delete(key); }
}

/** The target already exists: nothing was written over it. */
export class TargetExists extends Error {
  constructor(target: string) { super(`${target} already exists`); this.name = "TargetExists"; }
}

const isExists = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";

/**
 * Gives a finished temporary file its final name only if nothing has that
 * name yet, in one step: a file created there in the meantime is never
 * replaced. A hard link is tried first; where the drive has none (FAT, some
 * network shares) an exclusive copy does the same. The temporary name is
 * removed once the file is in place.
 */
export async function placeNewFile(temporary: string, target: string) {
  try {
    await link(temporary, target);
  } catch (error) {
    if (isExists(error)) throw new TargetExists(target);
    try { await copyFile(temporary, target, constants.COPYFILE_EXCL); } catch (copyError) {
      if (isExists(copyError)) throw new TargetExists(target);
      throw copyError;
    }
  }
  await rm(temporary, { force: true }).catch(() => {});
}
