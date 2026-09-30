import { open, readdir, readFile, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { requireActiveGrant, touchGrant } from "@/lib/local-files/grants";
import { LOCAL_FILE_LIMITS, LocalFileRefused } from "@/lib/local-files/limits";
import { resolveWithinGrant } from "@/lib/local-files/safe-path";
import { bindWriteApproval, verifyWriteApproval } from "@/lib/local-files/approval";

/*
 * The three operations the assistant may perform inside a folder the user
 * opened to it.
 *
 * Every one of them starts by re-reading the grant, so a permission withdrawn
 * in the middle of a turn takes effect on the very next call rather than at the
 * end of it. Nothing here accepts an absolute path or decides scope from the
 * model's own words: the grant is the boundary and `safe-path` is the only
 * thing that judges a name.
 */

export const listLocalFilesInputSchema = z.strictObject({
  grantId: z.string().min(1).max(200).describe("The folder the user granted. Use the id shown in the granted folders list."),
  path: z.string().max(2000).optional().default("").describe("Folder to list, relative to the granted folder. Empty lists the granted folder itself."),
  depth: z.number().int().min(1).max(LOCAL_FILE_LIMITS.depth).optional().default(2).describe("How many levels below the folder to walk."),
});

export const readLocalFileInputSchema = z.strictObject({
  grantId: z.string().min(1).max(200).describe("The folder the user granted."),
  path: z.string().min(1).max(2000).describe("File to read, relative to the granted folder."),
});

export const writeLocalFileInputSchema = z.strictObject({
  grantId: z.string().min(1).max(200).describe("The folder the user granted."),
  path: z.string().min(1).max(2000).describe("New file to create, relative to the granted folder."),
  content: z.string().max(LOCAL_FILE_LIMITS.characters).describe("Full contents of the new file."),
  /**
   * What the proposal assumed about the folder and the target, recorded when
   * the approval was raised and checked again before anything is written. Set
   * by the tool itself; the model does not supply it.
   */
  binding: z
    .object({
      grantId: z.string().min(1),
      grantRealPath: z.string().min(1),
      grantUpdatedAt: z.string().min(1),
      path: z.string().min(1),
      targetWasAbsent: z.boolean()
    })
    .optional(),
});

export type ReadLocalFileInput = z.infer<typeof readLocalFileInputSchema>;
export type WriteLocalFileInput = z.infer<typeof writeLocalFileInputSchema>;

export type LocalFileEntry = {
  path: string;
  name: string;
  kind: "file" | "folder";
  byteSize: number;
  modifiedAt: string;
};

export type ListLocalFilesOutput = {
  folder: string;
  grantLabel: string;
  entries: LocalFileEntry[];
  /** What stopped the walk, if anything. Said plainly so the model does not read a short list as a complete one. */
  truncated: string | null;
};

export type ReadLocalFileOutput = {
  path: string;
  grantLabel: string;
  byteSize: number;
  text: string;
  truncated: boolean;
};

export type WriteLocalFileOutput = {
  path: string;
  grantLabel: string;
  byteSize: number;
  created: true;
};

/**
 * Walk a granted folder, bounded on every axis that could cost something.
 *
 * The count, depth and elapsed-time ceilings are checked inside the walk rather
 * than after it, so a large tree costs a bounded amount of work instead of
 * running to completion and then being reported as "too much".
 */
export async function listGrantedFiles(input: { grantId: string; path?: string; depth?: number }): Promise<ListLocalFilesOutput> {
  const grant = await requireActiveGrant(input.grantId);
  // Defaulted here as well as in the schema: this function is the boundary the tool
  // executes against, and it must not depend on a caller having parsed first.
  const depth = input.depth ?? 2;
  const start = await resolveWithinGrant(grant, input.path ?? "", "list");

  const entries: LocalFileEntry[] = [];
  let seen = 0;
  let truncated: string | null = null;
  const deadline = Date.now() + LOCAL_FILE_LIMITS.walkTimeoutMs;

  async function walk(absolute: string, relative: string, remainingDepth: number): Promise<void> {
    if (truncated) return;
    if (Date.now() > deadline) {
      truncated = "Stopped after the time limit for one listing.";
      return;
    }
    let items: Dirent[];
    try {
      items = await readdir(absolute, { withFileTypes: true });
    } catch {
      // One unreadable subfolder must not end the whole listing.
      return;
    }
    // The depth the caller asked for is the depth actually walked: at the limit
    // the walk stops before descending rather than listing one level further.
    // It only says so when a folder below really held something, so an empty
    // last folder is not reported as a listing that was cut short.
    if (remainingDepth === 0) {
      if (items.some((entry) => entry.isDirectory() && !entry.name.startsWith("."))) {
        truncated = `Stopped at ${depth} levels deep.`;
      }
      return;
    }
    for (const item of items) {
      if (truncated) return;
      // Hidden entries are never listed either: refusing to read them is not
      // useful if the listing still advertises that they are there.
      if (item.name.startsWith(".")) continue;
      if (++seen > LOCAL_FILE_LIMITS.filesPerWalk) {
        truncated = `Stopped after ${LOCAL_FILE_LIMITS.filesPerWalk} entries.`;
        return;
      }
      const childRelative = relative ? `${relative}/${item.name}` : item.name;
      const childAbsolute = path.join(absolute, item.name);
      if (item.isDirectory()) {
        entries.push({ path: childRelative, name: item.name, kind: "folder", byteSize: 0, modifiedAt: "" });
        await walk(childAbsolute, childRelative, remainingDepth - 1);
      } else if (item.isFile()) {
        const stats = await stat(childAbsolute).catch(() => null);
        entries.push({
          path: childRelative,
          name: item.name,
          kind: "file",
          byteSize: stats?.size ?? 0,
          modifiedAt: stats ? stats.mtime.toISOString() : ""
        });
      }
    }
  }

  await walk(start.absolutePath, "", depth);

  const bounded = entries.slice(0, LOCAL_FILE_LIMITS.listEntries);
  if (bounded.length < entries.length) {
    truncated = `Showing the first ${LOCAL_FILE_LIMITS.listEntries} of ${entries.length} entries.`;
  }
  await touchGrant(grant.id);
  return { folder: start.relativePath || ".", grantLabel: grant.label, entries: bounded, truncated };
}

/**
 * Read one file's text.
 *
 * The file is resolved again here rather than trusted from the listing, because
 * a listing can be minutes old: a name that was inside the grant when it was
 * listed may have been replaced with a link since.
 */
export async function readGrantedFile(input: ReadLocalFileInput): Promise<ReadLocalFileOutput> {
  const grant = await requireActiveGrant(input.grantId);
  const target = await resolveWithinGrant(grant, input.path, "read");
  const bytes = await readFile(target.absolutePath);
  // Two ceilings, both enforced here rather than left to the schema: the bytes
  // one read may consume at all, and the characters it is handed back. The
  // bytes are decoded whole and cut afterwards, so the cut lands between
  // characters and never leaves half a code point at the end of the text.
  if (bytes.byteLength > LOCAL_FILE_LIMITS.readBytes) {
    throw new LocalFileRefused("too-large", "This file is larger than the limit for a single read.");
  }
  const decoded = bytes.toString("utf8");
  const truncated = decoded.length > LOCAL_FILE_LIMITS.characters;
  const text = truncated ? decoded.slice(0, LOCAL_FILE_LIMITS.characters) : decoded;
  await touchGrant(grant.id);
  return { path: target.relativePath, grantLabel: grant.label, byteSize: bytes.byteLength, text, truncated };
}

/**
 * Create a new file inside a granted folder.
 *
 * The create is exclusive: `wx` fails if anything is already at that path, and
 * the check and the create are the same operation, so there is no window in
 * which an existing file could be replaced between the two. Overwriting is not
 * a mode this version offers — the refusal names the file that is in the way
 * so the user can decide what to do about it.
 */
export async function writeGrantedFile(input: WriteLocalFileInput): Promise<WriteLocalFileOutput> {
  // Checked here as well as in the schema: this function is the boundary the
  // tool executes against, and it must not depend on a caller having parsed.
  if (input.content.length > LOCAL_FILE_LIMITS.characters) {
    throw new LocalFileRefused("too-large", "The content is larger than the limit for one file.");
  }
  if (input.path.length > 2000) {
    throw new LocalFileRefused("name-too-long", "The name is too long.");
  }
  // Fails closed. A write with no binding has no record of what the user
  // approved, so there is nothing to check it against and it does not happen.
  if (!input.binding) {
    throw new LocalFileRefused("outside-grant", "That write was not approved against a recorded state, so it did not run.");
  }
  // The binding checked one name and the write uses another. Comparing them
  // here is what stops an approval granted for one file being spent on
  // whatever else arrived in the same input.
  if (input.binding.path !== input.path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")) {
    throw new LocalFileRefused("outside-grant", "That request was approved for a different file.");
  }
  await verifyWriteApproval(input.binding);
  const grant = await requireActiveGrant(input.grantId);
  const target = await resolveWithinGrant(grant, input.path, "write");

  // The exclusive create is a separate step from filling the file, so the file
  // is opened `wx` and then written through that handle. Whatever goes wrong
  // afterwards takes the half-written file with it: leaving one behind would
  // make the next attempt fail as "that name is taken", which is both untrue
  // and unfixable from here, because this version never overwrites.
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(target.absolutePath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LocalFileRefused("not-a-file", "A file with that name already exists. Choose another name; this version never overwrites.");
    }
    throw error;
  }
  try {
    await handle.writeFile(input.content, "utf8");
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(target.absolutePath, { force: true }).catch(() => undefined);
    throw error;
  }
  await touchGrant(grant.id);
  return { path: target.relativePath, grantLabel: grant.label, byteSize: Buffer.byteLength(input.content, "utf8"), created: true };
}

/** Records what a write proposal assumes, so the approval can be checked against it later. */
export { bindWriteApproval };
