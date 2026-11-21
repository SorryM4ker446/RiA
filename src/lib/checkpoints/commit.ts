import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { placeNewFile, TargetExists } from "@/lib/local-files/file-writes";
import { CHECKPOINT_LIMITS, putBlob, sha256 } from "./store";

/*
 * The last step of an undo or redo: a file is changed only if, at that
 * moment, it is still what the records say. The file is first moved aside
 * under a temporary name in one step, so what is checked is exactly what is
 * replaced; anything else is put back untouched. New content takes the name
 * only while nothing else holds it, so a file created there in the meantime
 * is never written over. The moved-aside file stays until the caller has
 * recorded the change, so a change that cannot be recorded can be taken back.
 */

/** A SHA-256 the file must have now, or null when there must be no file. */
export type Expected = string | null;
/** The content to leave: its SHA-256, and how to write it to a new file at a given path (false when it is no longer available). */
export type Next = { hash: string; write: (temporary: string) => Promise<boolean> };

export type Committed = {
  status: "done";
  /** Removes what was moved aside; the change stands. */
  finish(): Promise<void>;
  /** Puts the file back as it was, if it is still as this change left it; false when it is not. */
  revert(): Promise<boolean>;
};
export type CommitResult = Committed | { status: "changed" } | { status: "missing-content" };

const temporaryBeside = (absolute: string, suffix: string) => path.join(path.dirname(absolute), `.ria-undo-${randomUUID()}.${suffix}`);
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** A file's SHA-256, read as a stream whatever its size. */
export async function sha256OfFile(absolute: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The file's hash, and its bytes when small enough to keep. */
async function read(absolute: string): Promise<{ hash: string; bytes: Buffer | null }> {
  if ((await stat(absolute)).size <= CHECKPOINT_LIMITS.fileBytes) {
    const bytes = await readFile(absolute);
    return { hash: sha256(bytes), bytes };
  }
  return { hash: await sha256OfFile(absolute), bytes: null };
}

/** Moves the file aside; null when there is no file. */
async function claim(absolute: string): Promise<string | null> {
  const aside = temporaryBeside(absolute, "aside");
  try {
    if (!(await lstat(absolute)).isFile()) return null;
    await rename(absolute, aside);
    return aside;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return null;
    throw error;
  }
}

/** Gives a moved-aside file its name back. If another file took the name meanwhile, both are left as they are. */
async function putBack(aside: string, absolute: string) {
  try { await placeNewFile(aside, absolute); return true; } catch (error) {
    if (error instanceof TargetExists) { console.error("checkpoints.commit.kept-aside", aside); return false; }
    throw error;
  }
}

/**
 * Replaces, creates or (next null) deletes the file when it is as expected.
 * keep: the content replaced is kept in the store first, for redo.
 */
export async function commitFile(absolute: string, expected: Expected, next: Next | null, options: { keep?: boolean } = {}): Promise<CommitResult> {
  // The new content is written first, so the file is away from its name only briefly.
  const temporary = next ? temporaryBeside(absolute, "tmp") : null;
  try {
    if (next && !await next.write(temporary!)) return { status: "missing-content" };
    let aside: string | null = null;
    if (expected !== null) {
      aside = await claim(absolute);
      if (!aside) return { status: "changed" };
      const current = await read(aside).catch(async error => { await putBack(aside!, absolute); throw error; });
      if (current.hash !== expected) { await putBack(aside, absolute); return { status: "changed" }; }
      if (options.keep && current.bytes) {
        try { await putBlob(current.bytes, current.hash); } catch (error) {
          await putBack(aside, absolute);
          throw error;
        }
      }
    }
    if (temporary) {
      try { await placeNewFile(temporary, absolute); } catch (error) {
        if (aside) await putBack(aside, absolute);
        if (error instanceof TargetExists) return { status: "changed" };
        throw error;
      }
    }
    const movedAside = aside;
    return {
      status: "done",
      finish: async () => { if (movedAside) await rm(movedAside, { force: true }).catch(() => {}); },
      revert: async () => {
        // Take back exactly what this change left, then return what was there.
        if (next) {
          const ours = await claim(absolute);
          if (!ours) return false;
          if ((await read(ours).catch(() => null))?.hash !== next.hash) { await putBack(ours, absolute); return false; }
          await rm(ours, { force: true });
        } else if (await stat(absolute).then(() => true, () => false)) return false;
        return movedAside ? putBack(movedAside, absolute) : true;
      },
    };
  } finally { if (temporary) await rm(temporary, { force: true }).catch(() => {}); }
}
