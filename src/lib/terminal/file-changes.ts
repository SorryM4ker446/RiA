import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { CHECKPOINT_LIMITS, putBlob, storeGeneration } from "@/lib/checkpoints/store";
import { IGNORED_COPY_BYTES, gitBlobHasher, isIgnored, readGitView, type GitView } from "@/lib/checkpoints/git";
import { isSameOrInside } from "@/lib/local-files/safe-path";
import type { TerminalFileChange, TerminalFileChanges } from "./schema";

const ignored = new Set([".git", "node_modules", ".next", ".venv", "__pycache__"]);
/**
 * entries and durationMs bound one walk; readBytes bounds what one walk reads
 * (a file already seen unchanged is not read again); lineBytes is the largest
 * file whose lines are counted; changes is how many are listed in a result.
 */
export const FILE_SNAPSHOT_LIMITS = { entries: 100_000, readBytes: 1024 * 1024 * 1024, lineBytes: 8 * 1024 * 1024, durationMs: 10_000, changes: 100 } as const;
const limits = FILE_SNAPSHOT_LIMITS;

/**
 * One file as a walk saw it. kept: its content can be given back, from the
 * checkpoint store under hash or, with gitOid, from the workspace's git
 * repository. skipped: why it is not kept (generation: the store's, for
 * "store-full", so it is tried again only once room opens up).
 */
export type FileVersion = {
  bytes: number; lines?: number; hash?: string; modified: number; changed: number;
  kept?: boolean; gitOid?: string; skipped?: "too-large" | "ignored" | "store-full"; generation?: number;
};
export type FileSnapshot = { files: Map<string, FileVersion>; complete: boolean };
export type FileDifference = { path: string; kind: TerminalFileChange["kind"]; before?: FileVersion; after?: FileVersion };

/*
 * What the last walk of each folder found, so the next walk reads only files
 * whose size or times changed: a folder is read in full once (when it is chosen
 * as a workspace, or by its first command) and after that each walk is mostly
 * metadata. Held in memory for the few folders in use; a restart starts over.
 */
const MAX_CACHED_ROOTS = 4;
type Store = { caches: Map<string, Map<string, FileVersion>>; queues: Map<string, Promise<unknown>> };
const store = () => ((globalThis as { __riaFileSnapshots?: Store }).__riaFileSnapshots ??= { caches: new Map(), queues: new Map() });

function cacheFor(root: string) {
  const { caches } = store();
  const found = caches.get(root) ?? new Map<string, FileVersion>();
  caches.delete(root); caches.set(root, found);
  while (caches.size > MAX_CACHED_ROOTS) caches.delete(caches.keys().next().value!);
  return found;
}

/** Walks of one folder run one at a time, so a command's walk reuses what the walk before it read. */
async function inOrder<T>(root: string, work: () => Promise<T>): Promise<T> {
  const { queues } = store();
  const run = (queues.get(root) ?? Promise.resolve()).catch(() => {}).then(work);
  queues.set(root, run);
  try { return await run; } finally { if (queues.get(root) === run) queues.delete(root); }
}

/** Every hash the current view of a folder keeps content for: pruning must not remove these. */
export function keptSnapshotHashes(): Set<string> {
  const hashes = new Set<string>();
  for (const cache of store().caches.values()) for (const version of cache.values()) if (version.kept && !version.gitOid && version.hash) hashes.add(version.hash);
  return hashes;
}

/** Content the checkpoint store no longer holds: a later walk keeps it again if it is still there. */
export function dropKeptSnapshotHashes(hashes: Set<string>) {
  if (!hashes.size) return;
  const generation = storeGeneration();
  for (const cache of store().caches.values()) for (const [name, version] of cache) {
    if (version.hash && !version.gitOid && hashes.has(version.hash)) cache.set(name, { ...version, kept: false, skipped: "store-full", generation });
  }
}

/** Forgets what was seen in a folder whose access ended. */
export function forgetFileSnapshot(root: string) { store().caches.delete(root); }

/** Reads a folder ahead of its first command, so that command starts without waiting on a full read. */
export function warmFileSnapshot(root: string) {
  void captureFileSnapshot(root, Infinity, { keep: true }).catch(() => {});
}

const countLines = (bytes: Buffer) => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.includes("\0")) return text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
  } catch { /* Binary files have a size summary rather than a line count. */ }
  return undefined;
};

/** The SHA-256 of a file read as a stream, and its git blob id too when one is to be compared. */
async function streamHash(absolute: string, size: number, oid?: string) {
  const hash = createHash("sha256");
  const git = oid ? gitBlobHasher(size, oid.length) : null;
  for await (const chunk of createReadStream(absolute)) { hash.update(chunk as Buffer); git?.update(chunk as Buffer); }
  return { hash: hash.digest("hex"), gitOid: git?.digest() };
}

/**
 * Observe the working tree without following junctions; file text is not held
 * in memory. With keep, each file's content is made recoverable, so a
 * command's changes to it can be undone: a file whose bytes are its blob in
 * the workspace's git index is left to git (any size); otherwise a copy goes
 * into the checkpoint store, unless the file is larger than
 * CHECKPOINT_LIMITS.fileBytes, ignored by git and larger than
 * IGNORED_COPY_BYTES, or the store is full. Each refusal is recorded once, so
 * later walks do not read the file again just to be refused again.
 */
export async function captureFileSnapshot(root: string, commandDeadline = Infinity, options: { keep?: boolean } = {}): Promise<FileSnapshot> {
  return inOrder(root, () => walk(root, commandDeadline, options.keep === true));
}

async function walk(root: string, commandDeadline: number, keep: boolean): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = { files: new Map(), complete: true };
  const cache = cacheFor(root);
  let entries = 0, readBytes = 0;
  const deadline = Math.min(Date.now() + limits.durationMs, commandDeadline);
  const git: GitView | null = keep ? await readGitView(root) : null;
  const generation = storeGeneration();
  async function read(name: string, absolute: string, info: { size: number; mtimeMs: number; ctimeMs: number }, version: FileVersion): Promise<boolean> {
    if (readBytes + info.size > limits.readBytes) return true;
    readBytes += info.size;
    const oid = git?.oids.get(name);
    if (info.size > CHECKPOINT_LIMITS.fileBytes) {
      // Too large to copy: hashed as it streams, so a change is still recognised, and git may still hold it.
      const streamed = await streamHash(absolute, info.size, oid);
      version.hash = streamed.hash;
      if (keep) Object.assign(version, oid && streamed.gitOid === oid ? { kept: true, gitOid: oid } : { kept: false, skipped: "too-large" });
      const current = await lstat(absolute);
      return current.size === info.size && current.mtimeMs === info.mtimeMs;
    }
    const file = await open(absolute, "r");
    try {
      const buffer = Buffer.alloc(info.size + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const current = await file.stat();
      if (bytesRead !== info.size || current.size !== info.size || current.mtimeMs !== info.mtimeMs) return false;
      const bytes = buffer.subarray(0, bytesRead);
      version.hash = createHash("sha256").update(bytes).digest("hex");
      if (info.size <= limits.lineBytes) version.lines = countLines(bytes);
      if (keep) {
        const blob = oid ? gitBlobHasher(info.size, oid.length) : null;
        if (blob && (blob.update(bytes), blob.digest()) === oid) Object.assign(version, { kept: true, gitOid: oid });
        else if (git && info.size > IGNORED_COPY_BYTES && isIgnored(git, name)) Object.assign(version, { kept: false, skipped: "ignored" });
        else {
          const stored = await putBlob(bytes, version.hash, { baseline: true }).catch(() => undefined);
          Object.assign(version, stored ? { kept: true } : stored === null ? { kept: false, skipped: "store-full", generation } : { kept: false });
        }
      }
      return true;
    } finally { await file.close(); }
  }
  async function visit(relative: string): Promise<void> {
    const directory = path.join(root, relative);
    if (!isSameOrInside(await realpath(directory), root)) { snapshot.complete = false; return; }
    const stream = await opendir(directory);
    for await (const entry of stream) {
      if (++entries > limits.entries || Date.now() > deadline) { snapshot.complete = false; return; }
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const name = path.posix.join(relative, entry.name);
      const absolute = path.join(root, name);
      try {
        if (entry.isDirectory()) { await visit(name); continue; }
        if (!entry.isFile()) continue;
        const info = await lstat(absolute);
        if (!info.isFile() || !isSameOrInside(await realpath(absolute), root)) { snapshot.complete = false; continue; }
        const seen = cache.get(name);
        // With keep, a file seen before is read again only if nothing was settled about keeping it.
        const settled = !keep || seen?.kept || (seen?.skipped && (seen.skipped !== "store-full" || seen.generation === generation));
        const unchanged = seen && seen.bytes === info.size && seen.modified === info.mtimeMs && seen.changed === info.ctimeMs && seen.hash && settled;
        if (unchanged) { snapshot.files.set(name, seen); continue; }
        const version: FileVersion = { bytes: info.size, modified: info.mtimeMs, changed: info.ctimeMs };
        if (!await read(name, absolute, info, version)) { snapshot.complete = false; continue; }
        snapshot.files.set(name, version);
        if (version.hash) cache.set(name, version);
      } catch { snapshot.complete = false; }
    }
  }
  try {
    if (await realpath(root) !== root) return { files: new Map(), complete: false };
    await visit("");
  } catch { snapshot.complete = false; }
  // A complete walk is the whole folder: files no longer there are forgotten.
  if (snapshot.complete) for (const name of [...cache.keys()]) if (!snapshot.files.has(name)) cache.delete(name);
  return snapshot;
}

/** Every file that differs between two walks, as far as both walks could tell. */
export function snapshotDifferences(before: FileSnapshot, after: FileSnapshot): FileDifference[] {
  const differences: FileDifference[] = [];
  for (const name of new Set([...before.files.keys(), ...after.files.keys()])) {
    const first = before.files.get(name), last = after.files.get(name);
    // A partial walk cannot establish that an unobserved file was absent.
    if ((!first && !before.complete) || (!last && !after.complete)) continue;
    const equal = first && last && (first.hash && last.hash ? first.hash === last.hash
      : first.bytes === last.bytes && first.modified === last.modified && first.changed === last.changed);
    if (equal) continue;
    differences.push({ path: name, kind: !first ? "created" : !last ? "deleted" : "modified", before: first, after: last });
  }
  return differences;
}

export function compareFileSnapshots(before: FileSnapshot, after: FileSnapshot): TerminalFileChanges {
  const version = (value: FileVersion | undefined) => value ? { bytes: value.bytes, ...(value.lines === undefined ? {} : { lines: value.lines }) } : null;
  const files = snapshotDifferences(before, after).map(({ path, kind, before, after }) => ({ path, kind, before: version(before), after: version(after) }));
  return { files: files.slice(0, limits.changes), complete: before.complete && after.complete && files.length <= limits.changes };
}
