import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, sep } from "node:path";
import { db } from "@/db";
import { scheduleDocumentIndexing } from "@/lib/documents/auto-index";
import { saveImportedDocument } from "@/lib/documents/import-file";
import { clearDocumentOcr } from "@/lib/documents/ocr/runner";
import { deleteDocument } from "@/lib/documents/store";
import { DOCUMENT_LIMITS, type DocumentFormat } from "@/lib/documents/types";
import { localCacheDirectory, localDataDirectory } from "@/lib/local/data-directory";
import { LocalFileRefused } from "@/lib/local-files/limits";
import { resolveGrant } from "@/lib/local-files/safe-path";
import { t, tf } from "@/lib/locale";
import { ApiError } from "@/lib/server/api-error";
import { runBackgroundDataOperation } from "@/lib/server/data-operations";

/*
 * Folders the knowledge base keeps in step with.
 *
 * Every supported file in a synced folder (subfolders included) is a document
 * named `<folder>/<path inside it>`. A scan compares each file's size and
 * modification time with what it saw last, imports what is new or changed
 * through the same path as an upload (OCR included), and removes the documents
 * of files that left the folder. While the service runs, each folder is also
 * watched, so a change is picked up a couple of seconds after it is saved; a
 * scan at start-up catches what changed while RiA was closed.
 *
 * Deleting is only ever decided from a complete scan of a folder that is there:
 * a folder that cannot be found (an unplugged drive), a subfolder that cannot
 * be read, or a scan cut short leaves its documents alone. Folders are only
 * read; adding one is not a directory grant and opens nothing to the assistant.
 * Scans run one folder at a time, each file in turn.
 */

export const FOLDER_LIMITS = {
  folders: 20,
  /** Entries a scan looks at before it stops; a folder this large was probably not meant. */
  entries: 200_000,
  /** How long a folder stays quiet after a change before it is scanned, so a save in several writes is read once. */
  watchDelayMs: 2_000,
  /** A folder that keeps changing (a log written all the time) is still scanned at least this often. */
  watchMaxDelayMs: 30_000,
  /** How often folders that are not watched (missing, or whose watcher failed) are looked at again. */
  recheckMs: 60_000,
  /** How long a scan waits for the parser or a backup restore before trying the same file again. */
  busyDelayMs: 2_000,
  busyAttempts: 15,
  /** Document names past this are not imported; citations and backups hold names up to it. */
  filename: 180,
  label: 60,
  problemsListed: 20,
} as const;

const FORMATS = new Set<DocumentFormat>(["pdf", "docx", "md", "txt"]);
/** Hidden entries, Office's lock files (`~$report.docx`), dependency and system folders. */
const skipped = (name: string) => name.startsWith(".") || name.startsWith("~$") || name === "node_modules" || /^(\$recycle\.bin|system volume information)$/i.test(name);

type Folder = NonNullable<Awaited<ReturnType<typeof db.knowledgeFolder.findUnique>>>;
type Run = { folderId: string; controller: AbortController; done: Promise<void> };
const state = globalThis as typeof globalThis & { knowledgeFolders?: {
  running: Promise<void> | null; queue: Map<string, { force: boolean }>; current: Run | null; removing: Set<string>;
  watching: boolean; watchers: Map<string, { watcher: FSWatcher; timer?: NodeJS.Timeout; since?: number }>; retry: { timer: NodeJS.Timeout | null; folders: Set<string> };
  recheck?: NodeJS.Timeout | null;
} };
const work = state.knowledgeFolders ??= { running: null, queue: new Map(), current: null, removing: new Set(), watching: false, watchers: new Map(), retry: { timer: null, folders: new Set() }, recheck: null };

const folded = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
const overlaps = (a: string, b: string) => {
  const [x, y] = [folded(a).replace(/[\\/]+$/, ""), folded(b).replace(/[\\/]+$/, "")];
  return x === y || x.startsWith(y + sep) || y.startsWith(x + sep);
};
const refused = (message: string) => new ApiError({ code: "VALIDATION_ERROR", message });

export type KnowledgeFolderView = {
  id: string; label: string; path: string; collection: string | null; status: string; error: string | null; lastSyncedAt: string | null;
  syncing: boolean; documents: number; failed: number; skipped: number;
  problems: Array<{ relativePath: string; status: string; error: string | null }>;
};

export async function listKnowledgeFolders(): Promise<KnowledgeFolderView[]> {
  const folders = await db.knowledgeFolder.findMany({ orderBy: { createdAt: "asc" } });
  const counts = await db.knowledgeFolderFile.groupBy({ by: ["folderId", "status"], _count: { _all: true } });
  const count = (folderId: string, status: string) => counts.find(row => row.folderId === folderId && row.status === status)?._count._all ?? 0;
  const problems = new Map(await Promise.all(folders.filter(folder => count(folder.id, "failed") + count(folder.id, "skipped")).map(async folder => [folder.id,
    await db.knowledgeFolderFile.findMany({ where: { folderId: folder.id, status: { in: ["failed", "skipped"] } }, orderBy: { relativePath: "asc" }, take: FOLDER_LIMITS.problemsListed, select: { relativePath: true, status: true, error: true } }),
  ] as const)));
  return folders.map(folder => ({
    id: folder.id, label: folder.label, path: folder.path, collection: folder.collection, status: folder.status, error: folder.error,
    lastSyncedAt: folder.lastSyncedAt?.toISOString() ?? null, syncing: work.current?.folderId === folder.id || work.queue.has(folder.id),
    documents: count(folder.id, "synced"), failed: count(folder.id, "failed"), skipped: count(folder.id, "skipped"),
    problems: problems.get(folder.id) ?? [],
  }));
}

/** Adds a folder the user chose and starts its first scan. */
export async function addKnowledgeFolder(input: { path: string; collection?: string | null }) {
  let resolved;
  try { resolved = await resolveGrant({ label: "", path: input.path }); }
  catch (error) {
    if (!(error instanceof LocalFileRefused)) throw error;
    throw refused(error.reason === "network-location" ? t("server.knowledgeFolders.network") : error.reason === "blocked-location" ? t("server.knowledgeFolders.blocked") : t("server.knowledgeFolders.notFound"));
  }
  if (resolved.isFile) throw refused(t("server.knowledgeFolders.notFolder"));
  // RiA's own data and cache hold the database and copies of documents, never documents to read.
  for (const own of [localDataDirectory("Knowledge folders"), localCacheDirectory("Knowledge folders")]) {
    const real = await realpath(own).catch(() => own);
    if (overlaps(resolved.realPath, real)) throw refused(t("server.knowledgeFolders.ownData"));
  }
  if (await db.knowledgeFolder.count() >= FOLDER_LIMITS.folders) throw new ApiError({ code: "CONFLICT", message: tf("server.knowledgeFolders.tooMany", { count: FOLDER_LIMITS.folders }) });
  const existing = await db.knowledgeFolder.findMany({ select: { label: true, realPath: true } });
  if (existing.some(folder => folded(folder.realPath) === folded(resolved.realPath))) throw new ApiError({ code: "CONFLICT", message: t("server.knowledgeFolders.already") });
  // A folder inside another synced one, or around it, would make two documents of every file they share.
  const nested = existing.find(folder => overlaps(folder.realPath, resolved.realPath));
  if (nested) throw new ApiError({ code: "CONFLICT", message: tf("server.knowledgeFolders.nested", { folder: nested.label }) });
  const collection = input.collection?.trim() || null;
  if (collection && collection.length > 40) throw refused(t("server.knowledgeFolders.collectionTooLong"));
  // The label starts every document name of the folder, so two folders never share one.
  const base = (basename(resolved.realPath) || resolved.realPath).slice(0, FOLDER_LIMITS.label - 4).trim() || "Folder";
  const taken = new Set(existing.map(folder => folded(folder.label)));
  let label = base;
  for (let number = 2; taken.has(folded(label)); number++) label = `${base} (${number})`;
  const folder = await db.knowledgeFolder.create({ data: { label, path: input.path.trim(), realPath: resolved.realPath, collection } });
  watchFolder(folder);
  scheduleFolderSync(folder.id);
  return (await listKnowledgeFolders()).find(view => view.id === folder.id)!;
}

/**
 * Stops syncing a folder. Its documents stay as ordinary documents unless
 * `deleteDocuments`, which removes them too. A scan of it under way stops first.
 */
export async function removeKnowledgeFolder(id: string, options: { deleteDocuments: boolean }) {
  const folder = await db.knowledgeFolder.findUnique({ where: { id } });
  if (!folder) throw new ApiError({ code: "NOT_FOUND", message: t("server.knowledgeFolders.notFoundId") });
  work.removing.add(id);
  try {
    unwatchFolder(id);
    work.queue.delete(id);
    if (work.current?.folderId === id) { work.current.controller.abort(); await work.current.done.catch(() => {}); }
    if (options.deleteDocuments) {
      const files = await db.knowledgeFolderFile.findMany({ where: { folderId: id, documentId: { not: null } }, select: { documentId: true } });
      for (const { documentId } of files) await forgetDocument(documentId!);
    }
    await db.knowledgeFolder.deleteMany({ where: { id } });
  } finally { work.removing.delete(id); }
}

async function forgetDocument(documentId: string) {
  try { await deleteDocument(documentId); }
  catch (error) { if (!(error instanceof ApiError && error.code === "NOT_FOUND")) throw error; }
  await clearDocumentOcr(documentId);
}

/** Queues a scan; `force` also retries files that failed and have not changed since. */
export function scheduleFolderSync(folderId: string, options: { force?: boolean } = {}) {
  if (work.removing.has(folderId)) return;
  work.queue.set(folderId, { force: Boolean(work.queue.get(folderId)?.force || options.force) });
  if (work.running) return;
  work.running = (async () => {
    try {
      for (let next = work.queue.entries().next(); !next.done; next = work.queue.entries().next()) {
        const [id, { force }] = next.value;
        work.queue.delete(id);
        const controller = new AbortController();
        const done = syncFolder(id, force, controller.signal);
        work.current = { folderId: id, controller, done };
        try { await done; }
        catch (error) {
          try { console.error("documents.folders.sync.failed", error instanceof Error ? error.message : String(error)); } catch { /* already harmless */ }
          await db.knowledgeFolder.updateMany({ where: { id }, data: { status: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 300) } }).catch(() => {});
        } finally { work.current = null; }
      }
    } finally { work.running = null; }
  })();
}
export const knowledgeFolderSyncSettled = async () => { while (work.running) await work.running; };

/** Scans every folder: at start-up, after a restore, and when the library finds files that lost their document. */
export async function resumeKnowledgeFolders(options: { all?: boolean } = {}) {
  const folders = await db.knowledgeFolder.findMany({ where: options.all ? {} : { OR: [{ status: "pending" }, { files: { some: { status: "synced", documentId: null } } }] }, select: { id: true } });
  for (const folder of folders) scheduleFolderSync(folder.id);
}

/** Watches every synced folder from now on and scans each once; the desktop service calls it after starting. */
export async function startKnowledgeFolderWatching() {
  work.watching = true;
  for (const folder of await db.knowledgeFolder.findMany()) watchFolder(folder);
  await resumeKnowledgeFolders({ all: true });
  if (work.recheck) clearInterval(work.recheck);
  work.recheck = setInterval(() => { void recheckKnowledgeFolders().catch(() => {}); }, FOLDER_LIMITS.recheckMs);
  work.recheck.unref?.();
}

/**
 * Folders that are not watched (not found at the last scan, or whose watcher failed) are
 * looked at again: one that is there is watched and scanned, so a drive plugged back in
 * syncs within a minute. A folder still missing costs one look and no scan.
 */
export async function recheckKnowledgeFolders() {
  for (const folder of await db.knowledgeFolder.findMany()) {
    if (work.watchers.has(folder.id) || work.removing.has(folder.id)) continue;
    if (!(await stat(folder.realPath).catch(() => null))?.isDirectory()) continue;
    watchFolder(folder);
    scheduleFolderSync(folder.id);
  }
}

/** Stops watching every folder, and drops scans a change or a busy parser had lined up for later. */
export function stopKnowledgeFolderWatching() {
  work.watching = false;
  if (work.recheck) clearInterval(work.recheck);
  work.recheck = null;
  for (const id of [...work.watchers.keys()]) unwatchFolder(id);
  if (work.retry.timer) clearTimeout(work.retry.timer);
  work.retry = { timer: null, folders: new Set() };
}

function watchFolder(folder: Folder) {
  if (!work.watching || work.watchers.has(folder.id)) return;
  try {
    const watcher = watch(folder.realPath, { recursive: true, persistent: false }, (_event, name) => {
      if (name && String(name).split(/[\\/]/).some(skipped)) return;
      const entry = work.watchers.get(folder.id);
      if (!entry) return;
      if (entry.timer) clearTimeout(entry.timer);
      // Quiet for a moment first, so a save in several writes is read once; but never put off for longer than the bound.
      entry.since ??= Date.now();
      const delay = Math.min(FOLDER_LIMITS.watchDelayMs, Math.max(0, entry.since + FOLDER_LIMITS.watchMaxDelayMs - Date.now()));
      entry.timer = setTimeout(() => { entry.since = undefined; entry.timer = undefined; scheduleFolderSync(folder.id); }, delay);
      entry.timer.unref?.();
    });
    // The folder went away (a drive unplugged, the folder deleted) or watching failed: the scan says which,
    // and the recheck watches it again once it is there, at most once a minute.
    watcher.on("error", () => { unwatchFolder(folder.id); scheduleFolderSync(folder.id); });
    work.watchers.set(folder.id, { watcher });
  } catch { /* Not there now: its scan reports it missing. */ }
}
function unwatchFolder(id: string) {
  const entry = work.watchers.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.watcher.close();
  work.watchers.delete(id);
}

/** A scan stopped by the parser being busy or a restore running picks up again a little later. */
function retryLater(id: string) {
  work.retry.folders.add(id);
  if (work.retry.timer) return;
  work.retry.timer = setTimeout(() => {
    const folders = [...work.retry.folders];
    work.retry = { timer: null, folders: new Set() };
    for (const folder of folders) scheduleFolderSync(folder);
  }, 30_000);
  work.retry.timer.unref?.();
}
const busy = (error: unknown) => error instanceof ApiError && error.code === "SERVICE_UNAVAILABLE";
const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });

// Whole milliseconds: the database keeps a float to fewer digits than the file system reports, so a fraction would never compare equal.
type Seen = { size: number; modifiedAt: number; format: DocumentFormat };
/** Every supported file under the folder; subfolders that could not be read are listed, and `truncated` says the scan stopped early. */
async function walk(root: string, signal: AbortSignal) {
  const files = new Map<string, Seen>();
  const unreadable: string[] = [];
  let entries = 0;
  const pending = [""];
  while (pending.length) {
    if (signal.aborted) break;
    const directory = pending.pop()!;
    let listed;
    try { listed = await readdir(directory ? join(root, directory) : root, { withFileTypes: true }); }
    catch { unreadable.push(directory); continue; }
    for (const entry of listed) {
      if (++entries > FOLDER_LIMITS.entries) return { files, unreadable, truncated: true };
      // Links and junctions are not followed: they could lead out of the folder, or round in a loop.
      if (skipped(entry.name) || entry.isSymbolicLink()) continue;
      const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { pending.push(relativePath); continue; }
      const format = extname(entry.name).slice(1).toLowerCase() as DocumentFormat;
      if (!entry.isFile() || !FORMATS.has(format)) continue;
      try { const info = await stat(join(root, relativePath)); files.set(relativePath, { size: info.size, modifiedAt: Math.round(info.mtimeMs), format }); }
      catch { unreadable.push(relativePath); }
    }
  }
  return { files, unreadable, truncated: signal.aborted };
}

async function syncFolder(id: string, force: boolean, signal: AbortSignal) {
  const folder = await db.knowledgeFolder.findUnique({ where: { id } });
  if (!folder || signal.aborted) return;
  const mark = (data: { status: string; error: string | null; lastSyncedAt?: Date }) => db.knowledgeFolder.updateMany({ where: { id }, data });
  // The folder as it was added: one replaced by a link elsewhere is not followed there.
  const real = await realpath(folder.realPath).catch(() => null);
  if (!real || folded(real) !== folded(folder.realPath) || !(await stat(real).catch(() => null))?.isDirectory()) {
    unwatchFolder(id);
    await mark({ status: "missing", error: t("server.knowledgeFolders.missing") });
    return;
  }
  const { files, unreadable, truncated } = await walk(folder.realPath, signal);
  if (signal.aborted) return;
  if (unreadable.includes("")) { await mark({ status: "failed", error: t("server.knowledgeFolders.unreadable") }); return; }

  const rows = new Map((await db.knowledgeFolderFile.findMany({ where: { folderId: id } })).map(row => [row.relativePath, row]));
  let changed = false;
  for (const [relativePath, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (signal.aborted) return;
    const row = rows.get(relativePath);
    const same = row && row.byteSize === file.size && row.modifiedAt === file.modifiedAt;
    if (same && row.status === "synced" && row.documentId) continue;
    if (same && !force && row.status !== "synced") continue;
    const filename = `${folder.label}/${relativePath}`;
    let outcome: { status: string; error: string | null; documentId: string | null };
    if (filename.length > FOLDER_LIMITS.filename) outcome = { status: "skipped", error: tf("server.knowledgeFolders.pathTooLong", { count: FOLDER_LIMITS.filename }), documentId: null };
    else if (file.size > DOCUMENT_LIMITS.fileBytes) outcome = { status: "skipped", error: t("lib.documents.fileTooLarge"), documentId: null };
    else if (!file.size) outcome = { status: "skipped", error: t("lib.documents.emptyFile"), documentId: null };
    else {
      const imported = await importFile(folder, relativePath, file, filename, signal);
      if (imported === "stopped") return;
      if (imported === "busy") { retryLater(id); return; }
      outcome = imported.outcome;
      if (imported.changed) changed = true;
    }
    // A version that cannot be read keeps the document of the last one that could, until the file is fixed or goes.
    const data = { byteSize: file.size, modifiedAt: file.modifiedAt, ...outcome, documentId: outcome.documentId ?? row?.documentId ?? null };
    await db.knowledgeFolderFile.upsert({ where: { folderId_relativePath: { folderId: id, relativePath } }, create: { folderId: id, relativePath, ...data }, update: data });
  }

  // Files that left the folder take their documents with them, but only after a complete scan.
  if (!truncated) {
    for (const row of rows.values()) {
      if (files.has(row.relativePath) || unreadable.some(path => row.relativePath === path || row.relativePath.startsWith(`${path}/`))) continue;
      if (signal.aborted) return;
      if (row.documentId) {
        try { await runBackgroundDataOperation(() => forgetDocument(row.documentId!)); }
        catch (error) { if (busy(error)) { retryLater(id); return; } throw error; }
        changed = true;
      }
      await db.knowledgeFolderFile.deleteMany({ where: { id: row.id } });
    }
  }
  await mark(truncated
    ? { status: "failed", error: tf("server.knowledgeFolders.tooManyEntries", { count: FOLDER_LIMITS.entries }) }
    : { status: "synced", error: unreadable.length ? tf("server.knowledgeFolders.someUnreadable", { count: unreadable.length }) : null, lastSyncedAt: new Date() });
  if (changed) scheduleDocumentIndexing();
}

/** Imports one file; waits out a busy parser or a restore, and gives up on the scan for now if that goes on. */
async function importFile(folder: Folder, relativePath: string, file: Seen, filename: string, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const bytes = new Uint8Array(await readFile(join(folder.realPath, relativePath)));
      const result = await runBackgroundDataOperation(() => saveImportedDocument({ filename, collection: folder.collection, format: file.format, bytes }));
      return { outcome: { status: "synced", error: null, documentId: result.document.id }, changed: result.change !== "unchanged" };
    } catch (error) {
      if (!busy(error)) return { outcome: { status: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 300), documentId: null }, changed: false };
      if (attempt + 1 >= FOLDER_LIMITS.busyAttempts) return "busy" as const;
      await pause(FOLDER_LIMITS.busyDelayMs, signal);
      if (signal.aborted) return "stopped" as const;
    }
  }
}
