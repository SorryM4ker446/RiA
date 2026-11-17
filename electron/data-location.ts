import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync,
  rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { lstat, readdir, rm, statfs } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { backup, DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

/*
 * Where the data folder really is, and moving it.
 *
 * The application always opens its data at one fixed path (`%APPDATA%\RiA\data`
 * for an installed copy). To keep the data on another drive, that path becomes
 * a directory junction pointing there. Every version of RiA, the installer's
 * messages, the update log and the pre-migration backups keep using the same
 * path, so an older version, a reinstall or an in-app update finds the data
 * without knowing it moved. The junction is the only record of where the data
 * is; the small state file beside it holds a requested move, what the last move
 * did and the copies a move left behind, never the location itself.
 *
 * A move runs at start-up, before anything opens the data: the database is
 * copied with SQLite's online backup and checked, every other file is copied
 * and compared by SHA-256, and only then is the path switched. Each step is
 * recorded before it is taken, so a crash at any point either finishes the
 * switch on the next start or leaves the data where it was. When neither can be
 * confirmed, the start stops and asks; it never opens an empty workspace in the
 * data's place. The old copy is kept until the person deletes it.
 *
 * The cache (undo copies, terminal output, the web cache) follows the data
 * unless the person chooses a folder for it. Losing it loses no workspace
 * content, so a cache folder that cannot be found falls back to the data folder
 * instead of stopping the start.
 */

export const DATA_LOCATION_FORMAT = 1;
/** Written into a data folder a move produced or the person picked, so a junction can tell RiA data from any other folder. */
export const DATA_MARKER_FILE = ".ria-data.json";
/** Written into a cache folder RiA uses, so choosing it again is not refused as a folder with someone else's files. */
export const CACHE_MARKER_FILE = ".ria-cache.json";
/** Present while a copy is unfinished; only a folder carrying it is ever cleaned up. */
export const INCOMPLETE_MARKER_FILE = ".ria-move-incomplete";
/** The cache's parts that are worth carrying to a new cache folder: undo copies, terminal output, scanned PDFs waiting for OCR. */
export const CACHE_ENTRIES = ["checkpoints", "terminal-logs", "ocr"] as const;
/** Chromium's HTTP cache: rebuilt on its own, so it is never copied, only left behind and removed. */
export const WEB_CACHE_ENTRY = "chromium-cache";
/** Room left over on the target beyond the copy itself, for the database and logs to keep growing. */
const SPACE_HEADROOM_BYTES = 256 * 1024 * 1024;
const SPACE_FACTOR = 1.1;
/** How often a running copy reports how far it has got. */
const PROGRESS_INTERVAL_MS = 200;

export type DataLocationErrorCode =
  | "not-absolute" | "network-path" | "same-location" | "nested" | "not-directory" | "not-empty" | "not-ria-data"
  | "not-writable" | "cannot-link" | "insufficient-space" | "link-inside-data" | "verification-failed" | "in-use"
  | "database-check-failed" | "state-unreadable" | "state-newer" | "move-pending" | "update-in-progress" | "cancelled"
  | "unrecoverable" | "not-a-copy" | "in-current-use";

export class DataLocationError extends Error {
  constructor(readonly code: DataLocationErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

export type MoveMode = "copy" | "adopt";
type SwitchKind = "set-aside" | "relink" | "home";
export type PendingMove = {
  id: string;
  target: string;
  mode: MoveMode;
  requestedAt: string;
  phase: "requested" | "copying" | "switching";
  /** Whether the move created the target folder, so an unfinished copy removes the folder and not only its contents. */
  createdTarget: boolean;
  /** Where the copy is written when the data comes back to the fixed path; renamed into place on the switch. */
  staging?: string;
  switchKind?: SwitchKind;
  /** Where the real folder at the fixed path was renamed to, for a switch away from it. */
  setAside?: string;
  /** The junction's target before the switch, to restore it if the switch cannot finish. */
  previousTarget?: string;
};
export type PendingCacheMove = {
  id: string;
  /** The new cache folder, or null to follow the data again. */
  target: string | null;
  requestedAt: string;
};
export type MoveResult = {
  id: string;
  kind: "data" | "cache";
  outcome: "moved" | "failed" | "interrupted" | "cancelled";
  /** Where the data or cache was to go; null for a cache going back to following the data. */
  target: string | null;
  at: string;
  code?: string;
  message?: string;
  /** Whether the person has been told; the page says it once. */
  seen?: boolean;
};
/**
 * A data folder kept aside. `reason` says why, so the person can tell an old
 * copy from data left behind: `moved` is what a move switched away from,
 * `left` the folder that could not be found when an empty workspace was
 * started, `interrupted` a folder of a move that could not finish.
 */
export type DataCopy = { path: string; at: string; reason?: "moved" | "left" | "interrupted" };
export type DataLocationState = {
  format: typeof DATA_LOCATION_FORMAT;
  pending: PendingMove | null;
  pendingCache: PendingCacheMove | null;
  lastResult: MoveResult | null;
  /** Where the junction pointed after the last switch, used only to recover a junction that has gone missing. */
  linkedTarget: string | null;
  /** Folders a move left behind, kept until the person deletes them. */
  previousCopies: DataCopy[];
  /** A cache folder the person chose; null while the cache follows the data. */
  cache: { path: string } | null;
  /** Old cache parts to remove once a cache move has switched; removed at the next start if a crash came first. */
  cacheCleanup: string[];
  /** When the low-space hint was shown, so it is shown once. */
  lowSpaceHintAt: string | null;
};

export type UnavailableReason = "missing" | "not-ria-data" | "junction-missing" | "uncertain";
export type DataRootInspection =
  | { kind: "directory"; realPath: string }
  | { kind: "absent" }
  | { kind: "junction"; target: string; realPath: string }
  /**
   * The fixed path does not lead to RiA data: a drive unplugged, a letter changed, a folder emptied,
   * a junction removed, or a move that could not be finished. `expected` is where the data should be, when known.
   */
  | { kind: "unavailable"; expected: string | null; reason: UnavailableReason };

export type MoveProgress = { phase: "database" | "files" | "verifying" | "switching"; doneBytes: number; totalBytes: number };
export type MoveOptions = {
  databaseFileName: string;
  onProgress?: (progress: MoveProgress) => void;
  /** Stops a copy that is still running; the partial copy is removed and the data stays where it was. */
  signal?: AbortSignal;
  now?: () => Date;
  /** Free bytes on the volume holding a path; replaceable so tests can simulate a full drive. */
  freeSpace?: (path: string) => Promise<number>;
};

const windows = process.platform === "win32";
export const normalizedPath = (path: string) => {
  const stripped = path.replace(/^\\\\\?\\/, "");
  const resolved = resolve(stripped);
  const root = parse(resolved).root;
  return resolved.length > root.length ? resolved.replace(/[\\/]+$/, "") : resolved;
};
const normalized = normalizedPath;
export const samePath = (left: string, right: string) => windows ? normalized(left).toLowerCase() === normalized(right).toLowerCase() : normalized(left) === normalized(right);
/** Whether `inner` is `outer` itself or lies inside it. */
function within(inner: string, outer: string): boolean {
  const path = relative(windows ? normalized(outer).toLowerCase() : normalized(outer), windows ? normalized(inner).toLowerCase() : normalized(inner));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
const overlaps = (left: string, right: string) => within(left, right) || within(right, left);
const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
/** A name beside the fixed path that nothing uses yet: two moves in the same second must not collide. */
function freshSibling(root: string, label: "moved" | "incoming" | "damaged", date: Date) {
  const base = `${root}.${label}-${stamp(date)}`;
  let candidate = base;
  for (let index = 2; existsSync(candidate) || linkTarget(candidate) !== null; index++) candidate = `${base}-${index}`;
  return candidate;
}
const isSetAside = (root: string, folder: string) => samePath(dirname(folder), dirname(root)) && basename(folder).toLowerCase().startsWith(`${basename(root).toLowerCase()}.moved-`);

/** A file-system failure as the person can act on it: another program holding a file, or a full drive. */
function fsFailure(error: unknown, fallback: DataLocationErrorCode = "verification-failed"): DataLocationError {
  if (error instanceof DataLocationError) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return new DataLocationError("in-use", "Another program is using the data folder", { cause: code });
  if (code === "ENOSPC") return new DataLocationError("insufficient-space", "The drive ran out of space", { cause: code });
  return new DataLocationError(fallback, error instanceof Error ? error.message : String(error), code ? { cause: code } : {});
}
function checkTargetPath(raw: string) {
  const value = raw.trim();
  if (!value || !isAbsolute(value)) throw new DataLocationError("not-absolute", "Choose a full folder path");
  // SQLite is not safe on a network share, and a junction cannot point to one.
  if (/^[\\/]{2}/.test(value)) throw new DataLocationError("network-path", "A network location cannot hold the data");
  return normalized(value);
}

// --- the record ------------------------------------------------------------

export const dataLocationStateFile = (dataRoot: string) => `${normalized(dataRoot)}.location.json`;
const emptyState = (): DataLocationState => ({
  format: DATA_LOCATION_FORMAT, pending: null, pendingCache: null, lastResult: null, linkedTarget: null,
  previousCopies: [], cache: null, cacheCleanup: [], lowSpaceHintAt: null,
});

/** Reads the record, refusing one that is damaged or that a newer version wrote. */
export function readDataLocationState(dataRoot: string): DataLocationState {
  const file = dataLocationStateFile(dataRoot);
  if (!existsSync(file)) return emptyState();
  let parsed: Partial<DataLocationState>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DataLocationState>;
  } catch {
    throw new DataLocationError("state-unreadable", "The data location record cannot be read", { file });
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.format !== "number") throw new DataLocationError("state-unreadable", "The data location record cannot be read", { file });
  // A newer version may have recorded a move this one does not know how to finish; guessing could switch to a half-copied folder.
  if (parsed.format > DATA_LOCATION_FORMAT) throw new DataLocationError("state-newer", "The data location record was written by a newer version", { file, format: parsed.format });
  const base = emptyState();
  return {
    ...base, ...parsed, format: DATA_LOCATION_FORMAT,
    previousCopies: Array.isArray(parsed.previousCopies) ? parsed.previousCopies.filter(copy => typeof copy?.path === "string") : [],
    cacheCleanup: Array.isArray(parsed.cacheCleanup) ? parsed.cacheCleanup.filter(path => typeof path === "string") : [],
  };
}

/**
 * Reads the record for a start. A damaged one is set aside for diagnosis and the
 * start goes on from an empty record: the junction, not the record, says where
 * the data is. `recordLost` tells the caller that a missing data folder may not
 * be a fresh install. A record from a newer version still stops the start.
 */
export function loadDataLocationState(dataRoot: string, now: () => Date = () => new Date()): { state: DataLocationState; recordLost: string | null } {
  try {
    return { state: readDataLocationState(dataRoot), recordLost: null };
  } catch (error) {
    if (!(error instanceof DataLocationError) || error.code !== "state-unreadable") throw error;
    const file = dataLocationStateFile(dataRoot);
    const kept = freshSibling(file, "damaged", now());
    renameSync(file, kept);
    return { state: emptyState(), recordLost: kept };
  }
}

export function writeDataLocationState(dataRoot: string, state: DataLocationState) {
  const file = dataLocationStateFile(dataRoot);
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}
function updateState(dataRoot: string, change: (state: DataLocationState) => Partial<DataLocationState>) {
  const state = readDataLocationState(dataRoot);
  const next = { ...state, ...change(state) };
  writeDataLocationState(dataRoot, next);
  return next;
}

// --- where the data is -----------------------------------------------------

function linkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return normalized(readlinkSync(path));
  } catch {
    return null;
  }
}
const isMarked = (path: string) => existsSync(join(path, DATA_MARKER_FILE));
const isDirectory = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/**
 * Whether a folder holds RiA data: one a move or a pick marked, or one with a
 * database RiA's migrations ran on (a data folder someone copied by hand).
 */
export function recognizeDataFolder(path: string, databaseFileName: string): "marked" | "database" | null {
  if (!isDirectory(path)) return null;
  if (isMarked(path)) return "marked";
  const database = join(path, databaseFileName);
  if (!existsSync(database)) return null;
  try {
    const opened = new DatabaseSync(database, { readOnly: true });
    try {
      return opened.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'desktop_migrations'").get() ? "database" : null;
    } finally { opened.close(); }
  } catch {
    return null;
  }
}
function markDataFolder(path: string, now: Date, copiedFrom: string | null) {
  writeFileSync(join(path, DATA_MARKER_FILE), `${JSON.stringify({ format: "ria-data", version: 1, createdAt: now.toISOString(), copiedFrom }, null, 2)}\n`);
}

/** Where the data at the fixed path really is, and whether it can be opened. */
export function inspectDataRoot(dataRoot: string, state: DataLocationState = readDataLocationState(dataRoot), options: { recordLost?: boolean } = {}): DataRootInspection {
  const root = normalized(dataRoot);
  let stats;
  try { stats = lstatSync(root); } catch { stats = null; }
  if (!stats) {
    // A move that could not finish, a junction someone removed, or data renamed aside: none of these is a fresh install.
    if (state.pending?.phase === "switching") return { kind: "unavailable", expected: state.pending.target, reason: "uncertain" };
    if (state.linkedTarget) return { kind: "unavailable", expected: state.linkedTarget, reason: "junction-missing" };
    if (options.recordLost || setAsideSiblings(root).length) return { kind: "unavailable", expected: null, reason: "uncertain" };
    return { kind: "absent" };
  }
  if (!stats.isSymbolicLink()) return { kind: "directory", realPath: root };
  const target = linkTarget(root) ?? state.linkedTarget;
  if (!target || !isDirectory(target)) return { kind: "unavailable", expected: target, reason: "missing" };
  if (!isMarked(target)) return { kind: "unavailable", expected: target, reason: "not-ria-data" };
  return { kind: "junction", target, realPath: target };
}
function setAsideSiblings(root: string): string[] {
  try {
    return readdirSync(dirname(root)).map(name => join(dirname(root), name)).filter(path => isSetAside(root, path) && isDirectory(path));
  } catch {
    return [];
  }
}

/** Removes a junction without touching what it points to. */
function removeJunction(path: string) {
  try { rmdirSync(path); } catch { unlinkSync(path); }
}
function createJunction(target: string, path: string) {
  symlinkSync(target, path, "junction");
}

// --- copying ---------------------------------------------------------------

type TreeEntry = { relativePath: string; bytes: number };
/** Every file under a folder, refusing links: a copy that followed one could pull in or overwrite data outside it. */
function listTree(root: string, skip: (relativePath: string) => boolean): TreeEntry[] {
  const files: TreeEntry[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path);
      if (skip(relativePath)) continue;
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) throw new DataLocationError("link-inside-data", "The data folder contains a link, which a move cannot copy safely", { path: relativePath });
      if (stats.isDirectory()) visit(path);
      else if (stats.isFile()) files.push({ relativePath, bytes: stats.size });
    }
  };
  if (isDirectory(root)) visit(root);
  return files;
}
const folded = (name: string) => windows ? name.toLowerCase() : name;
/** What a data move leaves out at the top of the data folder: the database (copied on its own), markers, and the web cache. */
function rootSkip(databaseFileName: string) {
  const skipped = new Set([databaseFileName, `${databaseFileName}-wal`, `${databaseFileName}-shm`, `${databaseFileName}-journal`, DATA_MARKER_FILE, INCOMPLETE_MARKER_FILE, WEB_CACHE_ENTRY].map(folded));
  return (relativePath: string) => !relativePath.includes(sep) && skipped.has(folded(relativePath));
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(); } }));
  return hash.digest("hex");
}
async function defaultFreeSpace(path: string) {
  const stats = await statfs(parse(resolve(path)).root);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** Reports progress at a steady pace however small or large the pieces are. */
function progressReporter(totalBytes: number, onProgress?: (progress: MoveProgress) => void) {
  let last = 0;
  return (phase: MoveProgress["phase"], doneBytes: number, force = false) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    onProgress({ phase, doneBytes: Math.min(doneBytes, totalBytes), totalBytes });
  };
}
const cancelled = () => new DataLocationError("cancelled", "The move was cancelled");

/**
 * Copies files and checks each copy against the original's SHA-256. A file
 * already at the destination with the same content is left as it is, so a cache
 * move can be run again after a crash; one with different content stops the copy.
 */
async function copyFiles(source: string, destination: string, files: TreeEntry[], progress: { done: number; report: ReturnType<typeof progressReporter> }, signal?: AbortSignal, merge = false) {
  for (const file of files) {
    if (signal?.aborted) throw cancelled();
    const from = join(source, file.relativePath);
    const to = join(destination, file.relativePath);
    mkdirSync(dirname(to), { recursive: true });
    if (merge && existsSync(to)) {
      if (await fileDigest(to) !== await fileDigest(from)) throw new DataLocationError("not-empty", "The new folder already holds different files with the same names", { path: file.relativePath });
      progress.done += file.bytes;
      continue;
    }
    const hash = createHash("sha256");
    await pipeline(
      createReadStream(from),
      new Transform({ transform(chunk: Buffer, _encoding, callback) {
        if (signal?.aborted) { callback(cancelled()); return; }
        hash.update(chunk); progress.done += chunk.length; progress.report("files", progress.done);
        callback(null, chunk);
      } }),
      createWriteStream(to, { flags: "wx" }),
    );
    if (await fileDigest(to) !== hash.digest("hex")) throw new DataLocationError("verification-failed", "A copied file does not match the original", { path: file.relativePath });
    const stats = statSync(from);
    utimesSync(to, stats.atime, stats.mtime);
  }
}

/** SQLite's own check, run off the main thread so a large database does not freeze the progress window. */
function integrityCheck(path: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(workerData, { readOnly: true });
      try { parentPort.postMessage(database.prepare("PRAGMA integrity_check").all().map(row => row.integrity_check).join("\\n")); }
      finally { database.close(); }
    `, { eval: true, workerData: path });
    const abort = () => { void worker.terminate(); reject(cancelled()); };
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", result => { signal?.removeEventListener("abort", abort); resolvePromise(String(result)); });
    worker.once("error", error => { signal?.removeEventListener("abort", abort); reject(error); });
    worker.once("exit", code => { if (code !== 0) reject(new DataLocationError("database-check-failed", "The database check stopped")); });
  });
}

async function copyData(source: string, destination: string, options: MoveOptions) {
  mkdirSync(destination, { recursive: true });
  if (readdirSync(destination).length) throw new DataLocationError("not-empty", "Choose an empty folder");
  writeFileSync(join(destination, INCOMPLETE_MARKER_FILE), "");
  const files = listTree(source, rootSkip(options.databaseFileName));
  const database = join(source, options.databaseFileName);
  const databaseBytes = existsSync(database) ? statSync(database).size : 0;
  const totalBytes = databaseBytes + files.reduce((sum, file) => sum + file.bytes, 0);
  const report = progressReporter(totalBytes, options.onProgress);
  const progress = { done: 0, report };

  if (existsSync(database)) {
    report("database", 0, true);
    const copy = join(destination, options.databaseFileName);
    // A consistent snapshot, committed WAL content included, taken a few pages at a time so the window stays responsive.
    const sourceDatabase = new DatabaseSync(database, { readOnly: true });
    try {
      await backup(sourceDatabase, copy, { rate: 256, progress: ({ totalPages, remainingPages }) => {
        if (options.signal?.aborted) throw cancelled();
        report("database", totalPages ? Math.round(databaseBytes * (totalPages - remainingPages) / totalPages) : 0);
      } });
    } catch (error) {
      throw options.signal?.aborted ? cancelled() : fsFailure(error, "database-check-failed");
    } finally { sourceDatabase.close(); }
    report("verifying", databaseBytes, true);
    if (await integrityCheck(copy, options.signal) !== "ok") throw new DataLocationError("database-check-failed", "The copied database failed its integrity check");
    progress.done = databaseBytes;
  }

  report("files", progress.done, true);
  await copyFiles(source, destination, files, progress, options.signal);

  report("verifying", totalBytes, true);
  const copied = listTree(destination, rootSkip(options.databaseFileName));
  const copiedBytes = copied.reduce((sum, file) => sum + file.bytes, 0);
  if (copied.length !== files.length || copiedBytes !== totalBytes - databaseBytes) {
    throw new DataLocationError("verification-failed", "The copy does not hold the same files as the original", { files: files.length, copied: copied.length });
  }
  markDataFolder(destination, options.now?.() ?? new Date(), source);
  rmSync(join(destination, INCOMPLETE_MARKER_FILE), { force: true });
}

/** How much a copy of the current data needs, counted as the move will copy it. */
export function dataSize(realPath: string, databaseFileName: string): number {
  const database = join(realPath, databaseFileName);
  const databaseBytes = existsSync(database) ? statSync(database).size : 0;
  return databaseBytes + listTree(realPath, rootSkip(databaseFileName)).reduce((sum, file) => sum + file.bytes, 0);
}

/** A folder's size without following links, for the settings page; null when it cannot be read. */
export async function folderSize(path: string): Promise<number | null> {
  try {
    let total = 0;
    const visit = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name);
        const stats = await lstat(child);
        if (stats.isSymbolicLink()) continue;
        if (stats.isDirectory()) await visit(child);
        else total += stats.size;
      }
    };
    await visit(path);
    return total;
  } catch {
    return null;
  }
}

// --- checking a target -----------------------------------------------------

/** Writes and removes a probe file; returns the outermost folder it had to create, to be removed again. */
function probeWritable(directory: string): string | null {
  let created: string | null = null;
  let walk = directory;
  while (!existsSync(walk)) { created = walk; const parent = dirname(walk); if (parent === walk) break; walk = parent; }
  try {
    mkdirSync(directory, { recursive: true });
    const probe = join(directory, `.ria-probe-${randomUUID()}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
  } catch (error) {
    if (created) rmSync(created, { recursive: true, force: true });
    throw new DataLocationError("not-writable", "RiA cannot write to that folder", { cause: (error as NodeJS.ErrnoException).code });
  }
  return created;
}
/** A junction cannot point to every kind of drive; finding out after copying gigabytes would waste the copy. */
function probeJunction(dataRoot: string, target: string) {
  const probe = `${dataRoot}.probe-${randomUUID()}`;
  try {
    createJunction(target, probe);
  } catch (error) {
    throw new DataLocationError("cannot-link", "RiA cannot link to that folder", { cause: (error as NodeJS.ErrnoException).code });
  } finally {
    if (linkTarget(probe) !== null) removeJunction(probe);
  }
}

export type MoveCheck = { mode: MoveMode; target: string; requiredBytes: number; availableBytes: number | null; dataBytes: number };

/**
 * Checks a folder the person chose before anything is written to it. Returns
 * whether its data is to be copied there or, when it already holds RiA data,
 * used as it is.
 */
export async function validateMoveTarget(input: { dataRoot: string; target: string } & Pick<MoveOptions, "databaseFileName" | "freeSpace">): Promise<MoveCheck> {
  const target = checkTargetPath(input.target);
  const root = normalized(input.dataRoot);
  const inspection = inspectDataRoot(root);
  if (inspection.kind === "unavailable" || inspection.kind === "absent") throw new DataLocationError("same-location", "The current data folder is not available to move");
  const current = inspection.realPath;
  const goingHome = samePath(target, root);
  if (goingHome && inspection.kind === "directory") throw new DataLocationError("same-location", "The data is already there");
  if (!goingHome && samePath(target, current)) throw new DataLocationError("same-location", "The data is already there");
  if (!goingHome && (overlaps(target, current) || overlaps(target, root))) throw new DataLocationError("nested", "The new folder cannot be inside the current one, or contain it");
  const cache = readDataLocationState(root).cache;
  if (!goingHome && cache && overlaps(target, cache.path)) throw new DataLocationError("nested", "The new folder cannot be inside the cache folder, or contain it");

  let mode: MoveMode = "copy";
  if (!goingHome && existsSync(target)) {
    if (!isDirectory(target)) throw new DataLocationError("not-directory", "The chosen path is not a folder");
    if (readdirSync(target).length) {
      if (!recognizeDataFolder(target, input.databaseFileName) || !existsSync(join(target, input.databaseFileName))) throw new DataLocationError("not-empty", "Choose an empty folder, or one that already holds RiA data");
      mode = "adopt";
    }
  }

  // The copy is written beside the fixed path when the data comes back, so that volume is the one that needs room.
  const writeTo = goingHome ? dirname(root) : target;
  const dataBytes = dataSize(current, input.databaseFileName);
  const requiredBytes = mode === "adopt" ? 0 : Math.ceil(dataBytes * SPACE_FACTOR) + SPACE_HEADROOM_BYTES;
  const created = probeWritable(writeTo);
  let availableBytes: number | null = null;
  try {
    if (!goingHome) probeJunction(root, target);
    availableBytes = await (input.freeSpace ?? defaultFreeSpace)(writeTo).catch(() => null);
    if (requiredBytes && availableBytes !== null && availableBytes < requiredBytes) {
      throw new DataLocationError("insufficient-space", "Not enough free space for the data", { requiredBytes, availableBytes });
    }
  } finally {
    if (created) rmSync(created, { recursive: true, force: true });
  }
  return { mode, target: goingHome ? root : target, requiredBytes, availableBytes, dataBytes };
}

/** Update phases with a download or an installer in flight; a move waits until they are settled. */
const UPDATE_BUSY: ReadonlySet<string> = new Set(["downloading", "ready", "installing"]);
/**
 * A move is refused while an update is downloading, downloaded or installing:
 * the installer restarts the application itself, and the two must not race for
 * the next start-up.
 */
export function assertUpdateSettled(phase: string | null) {
  if (phase && UPDATE_BUSY.has(phase)) throw new DataLocationError("update-in-progress", "Finish or cancel the update first");
}

/** Records a move to run at the next start. The caller restarts the application. */
export async function requestDataMove(input: { dataRoot: string; target: string } & Pick<MoveOptions, "databaseFileName" | "freeSpace" | "now">): Promise<PendingMove> {
  const state = readDataLocationState(input.dataRoot);
  if (state.pending || state.pendingCache) throw new DataLocationError("move-pending", "A move is already waiting for the next start");
  const checked = await validateMoveTarget(input);
  const pending: PendingMove = {
    id: randomUUID(), target: checked.target, mode: checked.mode, requestedAt: (input.now?.() ?? new Date()).toISOString(),
    phase: "requested", createdTarget: false,
  };
  writeDataLocationState(input.dataRoot, { ...state, pending });
  return pending;
}

// --- running a data move ---------------------------------------------------

/**
 * Runs a move recorded for this start, or finishes or undoes one a crash
 * interrupted. Returns what happened, or null when nothing was pending. A
 * failure leaves the data where it was and says why. Only when the fixed path
 * can be made to lead to neither the old data nor the new does it throw
 * `unrecoverable`, keeping the record so the next attempt can finish it.
 */
export async function runPendingDataMove(dataRoot: string, options: MoveOptions): Promise<MoveResult | null> {
  const root = normalized(dataRoot);
  const state = readDataLocationState(root);
  const pending = state.pending;
  if (!pending) return null;
  const now = () => (options.now?.() ?? new Date());
  const save = (change: Partial<DataLocationState>) => { Object.assign(state, change); writeDataLocationState(root, state); };
  const settle = (result: Pick<MoveResult, "outcome" | "code" | "message">, change: Partial<DataLocationState> = {}) => {
    const outcome: MoveResult = { id: pending.id, kind: "data", target: pending.target, at: now().toISOString(), ...result };
    save({ ...change, pending: null, lastResult: outcome });
    return outcome;
  };

  if (pending.phase === "copying") {
    // The previous start stopped in the middle of copying. Nothing was switched; the partial copy goes.
    discardPartialCopy(pending);
    return settle({ outcome: "interrupted", code: "interrupted", message: "The previous move was interrupted before it finished copying" });
  }
  if (pending.phase === "switching") return finishSwitch(root, state, pending, now, settle, save);

  let prepared: PendingMove;
  try {
    const checked = await validateMoveTarget({ dataRoot: root, target: pending.target, databaseFileName: options.databaseFileName, freeSpace: options.freeSpace });
    const inspection = inspectDataRoot(root, state);
    if (inspection.kind !== "directory" && inspection.kind !== "junction") throw new DataLocationError("same-location", "The current data folder is not available to move");
    const goingHome = samePath(checked.target, root);
    prepared = {
      ...pending, mode: checked.mode, phase: "copying",
      createdTarget: !goingHome && checked.mode === "copy" && !existsSync(checked.target),
      ...(goingHome ? { staging: freshSibling(root, "incoming", now()) } : {}),
    };
    save({ pending: prepared });
    if (prepared.mode === "copy") await copyData(inspection.realPath, prepared.staging ?? prepared.target, options);
    // A folder someone copied by hand is marked now, so the junction recognises it from here on.
    else if (!isMarked(prepared.target)) markDataFolder(prepared.target, now(), null);
  } catch (error) {
    if (state.pending?.phase === "copying") discardPartialCopy(state.pending);
    const failure = fsFailure(error);
    return settle({ outcome: failure.code === "cancelled" ? "cancelled" : "failed", code: failure.code, message: failure.message });
  }

  const inspection = inspectDataRoot(root, state);
  const switchKind: SwitchKind = prepared.staging ? "home" : inspection.kind === "junction" ? "relink" : "set-aside";
  save({ pending: {
    ...prepared, phase: "switching", switchKind,
    ...(switchKind === "set-aside" ? { setAside: freshSibling(root, "moved", now()) } : {}),
    ...(inspection.kind === "junction" ? { previousTarget: inspection.target } : {}),
  } });
  options.onProgress?.({ phase: "switching", doneBytes: 0, totalBytes: 0 });
  return finishSwitch(root, state, state.pending!, now, settle, save);
}

/** Puts the new folder at the fixed path, or puts the old one back. Safe to run again after a crash. */
function finishSwitch(
  root: string, state: DataLocationState, pending: PendingMove, now: () => Date,
  settle: (result: Pick<MoveResult, "outcome" | "code" | "message">, change?: Partial<DataLocationState>) => MoveResult,
  save: (change: Partial<DataLocationState>) => void,
): MoveResult {
  const newFolder = pending.staging ?? pending.target;
  const ready = isDirectory(newFolder) && isMarked(newFolder) && !existsSync(join(newFolder, INCOMPLETE_MARKER_FILE));
  const previous = pending.switchKind === "set-aside" ? pending.setAside! : pending.previousTarget ?? null;
  const done = (): MoveResult => settle({ outcome: "moved" }, {
    linkedTarget: pending.switchKind === "home" ? null : pending.target,
    // The folder now in use comes off the list (a copy switched back to); the one left goes on it.
    previousCopies: [
      ...state.previousCopies.filter(copy => !samePath(copy.path, pending.target) && (!previous || !samePath(copy.path, previous))),
      ...(previous ? [{ path: previous, at: now().toISOString(), reason: "moved" as const }] : []),
    ],
  });
  const current = linkTarget(root);
  const rootExists = existsSync(root) || current !== null;

  // Already switched: the crash came after the switch and before the record said so.
  if (pending.switchKind !== "home" && current !== null && samePath(current, pending.target)) return done();
  if (pending.switchKind === "home" && rootExists && current === null && !(pending.staging && existsSync(pending.staging))) return done();

  try {
    if (!ready) throw new DataLocationError("verification-failed", "The copied data is not complete");
    if (pending.switchKind === "set-aside") {
      if (rootExists && current === null) renameSync(root, pending.setAside!);
      createJunction(pending.target, root);
    } else if (pending.switchKind === "relink") {
      if (current !== null) removeJunction(root);
      createJunction(pending.target, root);
    } else {
      if (current !== null) removeJunction(root);
      renameSync(pending.staging!, root);
    }
    return done();
  } catch (error) {
    // Whatever happened, the fixed path must lead to the data that was there before.
    try {
      if (!existsSync(root) && linkTarget(root) === null) {
        if (pending.switchKind === "set-aside" && pending.setAside && existsSync(pending.setAside)) renameSync(pending.setAside, root);
        else if (pending.previousTarget) createJunction(pending.previousTarget, root);
      }
    } catch { /* judged below by what is actually at the fixed path */ }
    const restoredTarget = linkTarget(root);
    const restored = pending.switchKind === "set-aside" ? isDirectory(root) && restoredTarget === null
      : pending.previousTarget !== undefined && restoredTarget !== null && samePath(restoredTarget, pending.previousTarget);
    if (!restored) {
      // Neither the old data nor the new can be put at the fixed path. Keep the record so a retry can finish it,
      // and stop the start: carrying on would open an empty workspace while the data sits beside it.
      save({ pending });
      throw new DataLocationError("unrecoverable", "The data folder could not be switched or put back", { setAside: pending.setAside, target: pending.target, cause: fsFailure(error).code });
    }
    discardPartialCopy(pending);
    // A finished copy the switch could not use duplicates data that is still in place.
    if (ready && pending.mode === "copy") removeCopy(newFolder, Boolean(pending.staging || pending.createdTarget));
    const failure = fsFailure(error, "cannot-link");
    return settle({ outcome: "failed", code: failure.code, message: failure.message });
  }
}

function removeCopy(folder: string, wholeFolder: boolean) {
  if (!isDirectory(folder)) return;
  if (wholeFolder) { rmSync(folder, { recursive: true, force: true }); return; }
  for (const entry of readdirSync(folder)) rmSync(join(folder, entry), { recursive: true, force: true });
}

/** Removes an unfinished copy, and only one: a folder without the incomplete marker is never touched. */
function discardPartialCopy(pending: PendingMove) {
  const folder = pending.staging ?? (pending.mode === "copy" ? pending.target : null);
  if (!folder || !existsSync(join(folder, INCOMPLETE_MARKER_FILE))) return;
  removeCopy(folder, Boolean(pending.staging || pending.createdTarget));
}

// --- recovering at start-up ------------------------------------------------

export type DataCopyCandidate = DataCopy & { source: "earlier" | "interrupted" };
/**
 * Folders the fixed path can be pointed back at when its data cannot be found:
 * copies a move left behind, and the folders of a move that could not finish.
 */
export function availableDataCopies(dataRoot: string, state: DataLocationState, databaseFileName: string): DataCopyCandidate[] {
  const root = normalized(dataRoot);
  const found: DataCopyCandidate[] = [];
  const add = (path: string | undefined, at: string, source: DataCopyCandidate["source"]) => {
    if (!path || found.some(copy => samePath(copy.path, path))) return;
    if (isSetAside(root, path) ? isDirectory(path) : recognizeDataFolder(path, databaseFileName)) found.push({ path, at, source });
  };
  const pending = state.pending;
  if (pending?.phase === "switching") {
    add(pending.setAside, pending.requestedAt, "interrupted");
    add(pending.previousTarget, pending.requestedAt, "interrupted");
    if (pending.staging && isMarked(pending.staging)) add(pending.staging, pending.requestedAt, "interrupted");
    if (isMarked(pending.target)) add(pending.target, pending.requestedAt, "interrupted");
  }
  for (const copy of [...state.previousCopies].reverse()) add(copy.path, copy.at, "earlier");
  for (const sibling of setAsideSiblings(root)) add(sibling, statSync(sibling).mtime.toISOString(), "earlier");
  return found;
}

/**
 * Points the fixed path at a data folder the person chose or picked from the
 * copies left behind. A copy set aside beside the fixed path is renamed back; any
 * other folder must hold recognisable RiA data and is linked. Clears a move that
 * could not finish, recording its folders as copies so nothing is forgotten.
 */
export function switchToDataFolder(dataRoot: string, folder: string, databaseFileName: string, now: () => Date = () => new Date()): void {
  const root = normalized(dataRoot);
  const chosen = checkTargetPath(folder);
  if (overlaps(chosen, root) && !isSetAside(root, chosen)) throw new DataLocationError("nested", "Choose a folder outside RiA's own data path");
  const setAside = isSetAside(root, chosen);
  if (!isDirectory(chosen)) throw new DataLocationError("not-directory", "That folder cannot be found");
  if (!setAside && !recognizeDataFolder(chosen, databaseFileName)) throw new DataLocationError("not-ria-data", "That folder does not hold RiA data");
  const state = readDataLocationState(root);
  if (linkTarget(root) !== null) removeJunction(root);
  else if (existsSync(root)) throw new DataLocationError("in-current-use", "The data folder is already there");
  if (setAside) renameSync(chosen, root);
  else {
    if (!isMarked(chosen)) markDataFolder(chosen, now(), null);
    createJunction(chosen, root);
  }
  writeDataLocationState(root, {
    ...state,
    pending: null,
    linkedTarget: setAside ? null : chosen,
    previousCopies: withCopies(state, abandonedFolders(state), "interrupted", now).filter(copy => !samePath(copy.path, chosen)),
  });
}

/**
 * Starts an empty workspace at the fixed path when the data cannot be found and
 * the person chose to carry on without it. Nothing is deleted: the folder the
 * data was expected in is kept on the list of copies, so it can be switched back
 * to from the settings once it turns up.
 */
export function startEmptyWorkspace(dataRoot: string, now: () => Date = () => new Date()): void {
  const root = normalized(dataRoot);
  const state = readDataLocationState(root);
  const expected = linkTarget(root) ?? state.linkedTarget;
  if (linkTarget(root) !== null) removeJunction(root);
  else if (existsSync(root)) throw new DataLocationError("in-current-use", "The data folder is already there");
  mkdirSync(root, { recursive: true });
  writeDataLocationState(root, {
    ...state, pending: null, linkedTarget: null,
    previousCopies: withCopies(withCopies(state, abandonedFolders(state), "interrupted", now), expected ? [expected] : [], "left", now),
  });
}
function abandonedFolders(state: DataLocationState): string[] {
  const pending = state.pending;
  if (pending?.phase !== "switching") return [];
  return [pending.setAside, pending.previousTarget, pending.target].filter((path): path is string => Boolean(path) && isDirectory(path!) && !existsSync(join(path!, INCOMPLETE_MARKER_FILE)));
}
function withCopies(state: Pick<DataLocationState, "previousCopies"> | DataCopy[], paths: string[], reason: NonNullable<DataCopy["reason"]>, now: () => Date): DataCopy[] {
  const copies = [...(Array.isArray(state) ? state : state.previousCopies)];
  for (const path of paths) if (!copies.some(copy => samePath(copy.path, path))) copies.push({ path, at: now().toISOString(), reason });
  return copies;
}

// --- copies left behind ----------------------------------------------------

/**
 * Permanently deletes a copy a move left behind. Only a folder on the list, set
 * aside beside the fixed path or carrying RiA's marker, never the data in use or
 * anything containing it.
 */
export async function deleteDataCopy(dataRoot: string, path: string): Promise<void> {
  const root = normalized(dataRoot);
  const state = readDataLocationState(root);
  const entry = state.previousCopies.find(copy => samePath(copy.path, path));
  if (!entry) throw new DataLocationError("not-a-copy", "That folder is not a copy RiA left behind");
  const folder = normalized(entry.path);
  const inUse = inspectDataRoot(root, state);
  const current = inUse.kind === "directory" || inUse.kind === "junction" ? inUse.realPath : null;
  if (overlaps(folder, root) && !isSetAside(root, folder)) throw new DataLocationError("in-current-use", "That folder is part of the data in use");
  if (current && overlaps(folder, current)) throw new DataLocationError("in-current-use", "That folder is part of the data in use");
  if (state.cache && overlaps(folder, state.cache.path)) throw new DataLocationError("in-current-use", "That folder holds the cache in use");
  if (isDirectory(folder)) {
    if (lstatSync(folder).isSymbolicLink()) throw new DataLocationError("not-a-copy", "That copy is a link");
    if (!isSetAside(root, folder) && !isMarked(folder)) throw new DataLocationError("not-a-copy", "That folder does not look like a copy RiA made");
    try { await rm(folder, { recursive: true, force: false, maxRetries: 3 }); } catch (error) { throw fsFailure(error); }
  }
  updateState(root, current => ({ previousCopies: current.previousCopies.filter(copy => !samePath(copy.path, folder)) }));
}

/** Takes a copy that no longer exists off the list. */
export function forgetDataCopy(dataRoot: string, path: string): void {
  updateState(dataRoot, state => {
    const entry = state.previousCopies.find(copy => samePath(copy.path, path));
    if (!entry) throw new DataLocationError("not-a-copy", "That folder is not a copy RiA left behind");
    if (isDirectory(entry.path)) throw new DataLocationError("in-current-use", "That copy still exists; delete it instead");
    return { previousCopies: state.previousCopies.filter(copy => copy !== entry) };
  });
}

export function acknowledgeResult(dataRoot: string, id: string): void {
  updateState(dataRoot, state => state.lastResult?.id === id ? { lastResult: { ...state.lastResult, seen: true } } : {});
}
export function recordLowSpaceHint(dataRoot: string, at: Date): void {
  updateState(dataRoot, () => ({ lowSpaceHintAt: at.toISOString() }));
}

// --- the cache -------------------------------------------------------------

/** Where the cache is for this start: the chosen folder when it can be used, else the data folder. */
export function resolveCacheRoot(dataRoot: string, state: DataLocationState): { path: string; custom: boolean; unavailable: string | null } {
  const root = normalized(dataRoot);
  if (!state.cache) return { path: root, custom: false, unavailable: null };
  const chosen = normalized(state.cache.path);
  if (isDirectory(chosen)) return { path: chosen, custom: true, unavailable: null };
  return { path: root, custom: false, unavailable: chosen };
}
const cacheParts = (root: string) => [...CACHE_ENTRIES, WEB_CACHE_ENTRY].map(entry => join(root, entry));
async function cacheBytes(root: string) {
  let total = 0;
  for (const entry of CACHE_ENTRIES) total += (await folderSize(join(root, entry))) ?? 0;
  return total;
}

export type CacheCheck = { target: string | null; requiredBytes: number; availableBytes: number | null; cacheBytes: number };
/** Checks a folder chosen for the cache; null means following the data again. */
export async function validateCacheTarget(input: { dataRoot: string; target: string | null; freeSpace?: MoveOptions["freeSpace"] }): Promise<CacheCheck> {
  const root = normalized(input.dataRoot);
  const state = readDataLocationState(root);
  const from = resolveCacheRoot(root, state);
  const bytes = await cacheBytes(from.path);
  if (input.target === null) {
    if (!state.cache) throw new DataLocationError("same-location", "The cache already follows the data");
    return { target: null, requiredBytes: bytes, availableBytes: await (input.freeSpace ?? defaultFreeSpace)(root).catch(() => null), cacheBytes: bytes };
  }
  const target = checkTargetPath(input.target);
  const inspection = inspectDataRoot(root, state);
  const dataFolder = inspection.kind === "directory" || inspection.kind === "junction" ? inspection.realPath : root;
  if (state.cache && samePath(target, state.cache.path)) throw new DataLocationError("same-location", "The cache is already there");
  if (overlaps(target, root) || overlaps(target, dataFolder)) throw new DataLocationError("nested", "Choose a folder outside the data folder; the cache follows the data there already");
  if (existsSync(target)) {
    if (!isDirectory(target)) throw new DataLocationError("not-directory", "The chosen path is not a folder");
    if (readdirSync(target).length && !existsSync(join(target, CACHE_MARKER_FILE))) throw new DataLocationError("not-empty", "Choose an empty folder");
  }
  const requiredBytes = Math.ceil(bytes * SPACE_FACTOR) + 64 * 1024 * 1024;
  const created = probeWritable(target);
  let availableBytes: number | null = null;
  try {
    availableBytes = await (input.freeSpace ?? defaultFreeSpace)(target).catch(() => null);
    if (availableBytes !== null && availableBytes < requiredBytes) throw new DataLocationError("insufficient-space", "Not enough free space for the cache", { requiredBytes, availableBytes });
  } finally {
    if (created) rmSync(created, { recursive: true, force: true });
  }
  return { target, requiredBytes, availableBytes, cacheBytes: bytes };
}

export async function requestCacheMove(input: { dataRoot: string; target: string | null; freeSpace?: MoveOptions["freeSpace"]; now?: () => Date }): Promise<PendingCacheMove> {
  const state = readDataLocationState(input.dataRoot);
  if (state.pending || state.pendingCache) throw new DataLocationError("move-pending", "A move is already waiting for the next start");
  const checked = await validateCacheTarget(input);
  const pendingCache: PendingCacheMove = { id: randomUUID(), target: checked.target, requestedAt: (input.now?.() ?? new Date()).toISOString() };
  writeDataLocationState(input.dataRoot, { ...state, pendingCache });
  return pendingCache;
}

/**
 * Carries the undo copies, terminal output and scanned PDFs waiting for OCR to the new cache folder, checking
 * each file, then switches and removes the old ones. A crash before the switch
 * leaves the old cache in use (the files already copied are reused next time);
 * one after it leaves old files that the next start removes.
 */
export async function runPendingCacheMove(dataRoot: string, options: Pick<MoveOptions, "onProgress" | "signal" | "now"> & { webCacheInUse?: string }): Promise<MoveResult | null> {
  const root = normalized(dataRoot);
  const now = () => options.now?.() ?? new Date();
  removeCacheLeftovers(root, readDataLocationState(root), options.webCacheInUse);
  const state = readDataLocationState(root);
  const pending = state.pendingCache;
  if (!pending) return null;
  const settle = (result: Pick<MoveResult, "outcome" | "code" | "message">, change: Partial<DataLocationState> = {}) => {
    const outcome: MoveResult = { id: pending.id, kind: "cache", target: pending.target, at: now().toISOString(), ...result };
    writeDataLocationState(root, { ...readDataLocationState(root), ...change, pendingCache: null, lastResult: outcome });
    return outcome;
  };
  const from = resolveCacheRoot(root, state);
  const to = pending.target ? normalized(pending.target) : root;
  try {
    const sources = CACHE_ENTRIES.map(entry => ({ entry, files: listTree(join(from.path, entry), () => false) }));
    const total = sources.reduce((sum, source) => sum + source.files.reduce((part, file) => part + file.bytes, 0), 0);
    const progress = { done: 0, report: progressReporter(total, options.onProgress) };
    progress.report("files", 0, true);
    mkdirSync(to, { recursive: true });
    // From the cache folder in use this run, which is the data folder while a chosen one is missing:
    // undo copies made meanwhile are carried too, not left behind and removed.
    if (!samePath(from.path, to)) for (const source of sources) await copyFiles(join(from.path, source.entry), join(to, source.entry), source.files, progress, options.signal, true);
    progress.report("switching", total, true);
    if (pending.target) writeFileSync(join(to, CACHE_MARKER_FILE), `${JSON.stringify({ format: "ria-cache", version: 1, createdAt: now().toISOString() }, null, 2)}\n`);
    const leftovers = samePath(from.path, to) ? [] : cacheParts(from.path);
    const result = settle({ outcome: "moved" }, { cache: pending.target ? { path: to } : null, cacheCleanup: leftovers });
    removeCacheLeftovers(root, readDataLocationState(root), options.webCacheInUse);
    return result;
  } catch (error) {
    const failure = fsFailure(error);
    return settle({ outcome: failure.code === "cancelled" ? "cancelled" : "failed", code: failure.code, message: failure.message });
  }
}
/**
 * Removes old cache parts a switch left. Only RiA's own cache folders, never
 * those of the cache in use, and not the web cache Chromium was pointed at for
 * this run (it is fixed before the app is ready); that one goes at the next start.
 */
function removeCacheLeftovers(root: string, state: DataLocationState, webCacheInUse?: string) {
  if (!state.cacheCleanup.length) return;
  const current = resolveCacheRoot(root, state).path;
  const remaining = state.cacheCleanup.filter(path => {
    if (samePath(dirname(path), current)) return false;
    if (![...CACHE_ENTRIES, WEB_CACHE_ENTRY].some(entry => folded(basename(path)) === folded(entry))) return false;
    if (webCacheInUse && samePath(path, webCacheInUse)) return true;
    try { rmSync(path, { recursive: true, force: true }); return false; } catch { return true; }
  });
  writeDataLocationState(root, { ...state, cacheCleanup: remaining });
}

/** The web cache folder for this run, decided before the app is ready from the record as it stands. */
export function webCacheDirectory(dataRoot: string, state: DataLocationState): string {
  return join(resolveCacheRoot(dataRoot, state).path, WEB_CACHE_ENTRY);
}
