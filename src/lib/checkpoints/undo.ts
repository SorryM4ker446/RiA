import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@/db";
import { withFileWriteLock } from "@/lib/local-files/file-writes";
import { isSameOrInside } from "@/lib/local-files/safe-path";
import { ApiError } from "@/lib/server/api-error";
import { t } from "@/lib/locale";
import { isTurnLive } from "@/lib/chat/live-turns";
import { terminalGrant } from "@/lib/terminal/runtime";
import { hasBlob, readBlob } from "./store";
import { writeGitBlob } from "./git";
import { commitFile, sha256OfFile, type Expected, type Next } from "./commit";

/*
 * Undoing a turn's file changes, and redoing them. Every file the chosen turns
 * changed is put back as it was before the first of them, and only if it is
 * still exactly as the last of them left it: a file changed since (by the
 * user, another program or a later turn) is left alone and reported. A file
 * the turns created is deleted; one they deleted is written again. The content
 * an undo replaces is kept first, so the undo itself can be taken back (redo)
 * while the file is still as the undo left it. Writes stay inside the folder,
 * take turns with RiA's other writes to the same file, and check the file once
 * more at the moment it is changed (commit.ts).
 */

export type UndoAction = "restore" | "delete" | "recreate";
export type UndoStatus = "ready" | "changed" | "not-kept" | "folder-unavailable" | "undone" | "redone" | "failed";
/**
 * pairedWith: the other half of a rename (a file deleted and the same content
 * created elsewhere). undone: the file's change is currently undone; redoable:
 * that undo can be taken back.
 */
export type UndoItem = { grantId: string; path: string; action: UndoAction; status: UndoStatus; reason?: string | null; pairedWith?: string; undone?: boolean; redoable?: boolean };
/** The files to undo; all of them when absent. */
export type UndoSelection = { grantId: string; path: string }[] | undefined;

type Row = Awaited<ReturnType<typeof rowsFor>>[number];
type Group = { first: Row; last: Row; ids: string[] };

/** The runs' changes still in place, or (undone) those currently undone. */
const rowsFor = (chatId: string, runIds: string[], undone = false) => db.fileCheckpoint.findMany({
  where: { chatId, runId: { in: runIds }, undoneAt: undone ? { not: null } : null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
});

const keyOf = (row: { grantId: string; path: string }) => `${row.grantId}\0${process.platform === "win32" ? row.path.toLowerCase() : row.path}`;

function groups(rows: Row[], selection?: UndoSelection): Group[] {
  const chosen = selection ? new Set(selection.map(keyOf)) : null;
  const found = new Map<string, Group>();
  for (const row of rows) {
    const group = found.get(keyOf(row));
    if (group) { group.last = row; group.ids.push(row.id); } else found.set(keyOf(row), { first: row, last: row, ids: [row.id] });
  }
  // A file the turns created and then removed again, or put back as it was, has nothing to undo.
  return [...found.values()].filter(({ first, last }) => !(first.kind === "created" && last.kind === "deleted")
    && !(first.kind !== "created" && last.kind !== "deleted" && first.beforeHash && first.beforeHash === last.afterHash)
    && (!chosen || chosen.has(keyOf(last))));
}

/** Renames: a file the turns deleted whose content they created under another name in the same folder. */
function pairRenames(items: UndoItem[], all: Group[]) {
  const byKey = new Map(all.map(group => [keyOf(group.last), group]));
  const created = all.filter(group => actionOf(group) === "delete");
  for (const item of items) {
    const group = byKey.get(keyOf(item));
    if (!group) continue;
    const action = actionOf(group);
    const match = action === "recreate"
      ? created.find(other => other.first.grantId === group.first.grantId && !!group.first.beforeHash && other.last.afterHash === group.first.beforeHash)
      : action === "delete" ? all.find(other => actionOf(other) === "recreate" && other.first.grantId === group.first.grantId && !!other.first.beforeHash && other.first.beforeHash === group.last.afterHash)
      : undefined;
    if (match) item.pairedWith = match.last.path;
  }
  return items;
}

const actionOf = ({ first, last }: Group): UndoAction => first.kind === "created" ? "delete" : last.kind === "deleted" ? "recreate" : "restore";

/** The file's place inside the folder, refusing anything that would lead outside it. */
async function placeOf(root: string, relative: string) {
  const segments = relative.split("/");
  if (!relative || relative.includes("\0") || relative.includes(":") || path.isAbsolute(relative) || segments.some(part => !part || part === "." || part === "..")) return null;
  const absolute = path.resolve(root, ...segments);
  if (!isSameOrInside(absolute, root)) return null;
  let existing = path.dirname(absolute);
  while (!(await stat(existing).then(() => true, () => false))) {
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    existing = parent;
  }
  if (!isSameOrInside(await realpath(existing), root)) return null;
  const info = await lstat(absolute).catch(() => null);
  if (info && !info.isFile()) return null;
  return { absolute, exists: !!info };
}


type Checked = UndoItem & { group: Group; absolute?: string };

async function check(group: Group, roots: Map<string, string | null>): Promise<Checked> {
  const { first, last } = group;
  const base = { grantId: first.grantId, path: last.path, action: actionOf(group), group };
  if (first.kind !== "created" && (!first.restorable || !first.beforeHash)) return { ...base, status: "not-kept", reason: first.reason };
  if (!roots.has(first.grantId)) roots.set(first.grantId, await terminalGrant(first.grantId).then(grant => grant.realPath, () => null));
  const root = roots.get(first.grantId);
  if (!root || root !== first.root || root !== last.root) return { ...base, status: "folder-unavailable" };
  const place = await placeOf(root, last.path).catch(() => null);
  if (!place) return { ...base, status: "folder-unavailable" };
  // Still exactly as the last change left it?
  const asLeft = last.kind === "deleted" ? !place.exists : !!last.afterHash && place.exists && await sha256OfFile(place.absolute).catch(() => null) === last.afterHash;
  return { ...base, absolute: place.absolute, status: asLeft ? "ready" : "changed" };
}

const view = ({ group: _group, absolute: _absolute, ...item }: Checked): UndoItem => item;

/** Whether an undone change can be redone: the content the undo replaced is kept, or there was none (the change was a deletion). */
const redoable = async (group: Group) => group.last.kind === "deleted" || (!!group.last.afterHash && await hasBlob(group.last.afterHash));

/** Whether an undone file is still exactly as the undo left it, so redoing it loses nothing. */
async function checkRedo(group: Group, roots: Map<string, string | null>): Promise<Checked> {
  const { first, last } = group;
  const base = { grantId: first.grantId, path: last.path, action: actionOf(group), group, undone: true };
  if (!await redoable(group)) return { ...base, status: "not-kept", reason: "expired", redoable: false };
  if (!roots.has(first.grantId)) roots.set(first.grantId, await terminalGrant(first.grantId).then(grant => grant.realPath, () => null));
  const root = roots.get(first.grantId);
  if (!root || root !== first.root) return { ...base, status: "folder-unavailable", redoable: false };
  const place = await placeOf(root, last.path).catch(() => null);
  if (!place) return { ...base, status: "folder-unavailable", redoable: false };
  const asUndone = first.kind === "created" ? !place.exists : place.exists && await sha256OfFile(place.absolute).catch(() => null) === first.beforeHash;
  return { ...base, absolute: place.absolute, status: asUndone ? "ready" : "changed", redoable: asUndone };
}

/**
 * Every file the runs changed and where its undo stands, from the records
 * alone (no file is read): undoable, not undoable (with the reason) or
 * undone, and whether that can be redone. Cheap enough to read whenever the
 * card showing the files appears.
 */
export async function undoStates(chatId: string, runIds: string[]): Promise<UndoItem[]> {
  const active = groups(await rowsFor(chatId, runIds));
  const undone = groups(await rowsFor(chatId, runIds, true));
  const items: UndoItem[] = active.map(group => {
    const kept = group.first.kind === "created" || (group.first.restorable && !!group.first.beforeHash);
    return { grantId: group.first.grantId, path: group.last.path, action: actionOf(group), status: kept ? "ready" : "not-kept", ...(kept ? {} : { reason: group.first.reason }) };
  });
  for (const group of undone) items.push({ grantId: group.first.grantId, path: group.last.path, action: actionOf(group), status: "undone", undone: true, redoable: await redoable(group) });
  return pairRenames(items, [...active, ...undone]);
}

/** What undoing the turns would do, file by file, without changing anything. */
export async function previewUndo(chatId: string, runIds: string[], selection?: UndoSelection): Promise<UndoItem[]> {
  const roots = new Map<string, string | null>();
  const rows = await rowsFor(chatId, runIds);
  const checked: UndoItem[] = [];
  for (const group of groups(rows, selection)) checked.push(view(await check(group, roots)));
  return pairRenames(checked, groups(rows));
}

const busy = new Set<string>();

const lockedCode = (error: unknown) => ["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "");

/** Makes sure the folder the file goes in exists and is still inside the workspace. */
async function prepareFolder(root: string, absolute: string) {
  await mkdir(path.dirname(absolute), { recursive: true });
  if (!isSameOrInside(await realpath(path.dirname(absolute)), root)) throw new Error("outside the folder");
}

/** Content from the store, as a new file at the temporary path. */
const fromStore = (hash: string): Next => ({
  hash,
  write: async temporary => {
    const bytes = await readBlob(hash);
    if (!bytes) return false;
    await writeFile(temporary, bytes, { flag: "wx" });
    return true;
  },
});

/** The content before the first change: from the workspace's git repository when it was left there, else from the store. */
const before = (root: string, first: Row): Next => ({
  hash: first.beforeHash!,
  write: async temporary => (!!first.beforeGitOid && await writeGitBlob(root, first.beforeGitOid, first.beforeHash!, temporary))
    || fromStore(first.beforeHash!).write(temporary),
});

type Step = { expected: Expected; next: Next | null; keep: boolean };

/**
 * Changes one file and records it, or leaves it as it is. The file is checked
 * again at the moment it is changed (another program, or RiA itself, may have
 * written it since the first check), and the change is taken back if it
 * cannot be recorded, so files and records never disagree.
 */
async function change(root: string, item: Checked, step: Step, record: () => Promise<unknown>): Promise<"done" | "changed" | "missing-content"> {
  const absolute = item.absolute!;
  return withFileWriteLock(absolute, async () => {
    if (step.next) await prepareFolder(root, absolute);
    const result = await commitFile(absolute, step.expected, step.next, { keep: step.keep });
    if (result.status !== "done") return result.status;
    try { await record(); } catch (error) {
      await result.revert().catch(() => false);
      throw error;
    }
    await result.finish();
    return "done";
  });
}

/** Undoes what can be undone, leaves the rest as it is, and says which was which. */
export async function applyUndo(chatId: string, runIds: string[], selection?: UndoSelection): Promise<UndoItem[]> {
  if (isTurnLive(chatId)) throw new ApiError({ code: "CONFLICT", message: t("server.conversation.stillAnswering") });
  if (busy.has(chatId)) throw new ApiError({ code: "CONFLICT", message: t("server.undo.busy") });
  busy.add(chatId);
  try {
    const roots = new Map<string, string | null>();
    const results: UndoItem[] = [];
    const undone: { grantId: string; path: string; action: UndoAction }[] = [];
    const rows = await rowsFor(chatId, runIds);
    for (const group of groups(rows, selection)) {
      const item = await check(group, roots);
      if (item.status !== "ready") { results.push(view(item)); continue; }
      const root = roots.get(item.grantId)!;
      try {
        const outcome = await change(root, item, {
          expected: group.last.kind === "deleted" ? null : group.last.afterHash,
          next: item.action === "delete" ? null : before(root, group.first),
          keep: item.action !== "recreate",
        }, () => db.fileCheckpoint.updateMany({ where: { id: { in: group.ids }, undoneAt: null }, data: { undoneAt: new Date() } }));
        if (outcome === "changed") { results.push(view({ ...item, status: "changed" })); continue; }
        if (outcome === "missing-content") { results.push(view({ ...item, status: "not-kept", reason: "expired" })); continue; }
        results.push(view({ ...item, status: "undone", undone: true, redoable: await redoable(group) }));
        undone.push({ grantId: item.grantId, path: item.path, action: item.action });
      } catch (error) {
        results.push(view({ ...item, status: "failed", reason: lockedCode(error) ? "locked" : null }));
      }
    }
    if (undone.length) noteUndo(chatId, undone);
    return pairRenames(results, groups(rows));
  } finally { busy.delete(chatId); }
}

/** What redoing undone changes would do, file by file, without changing anything. */
export async function previewRedo(chatId: string, runIds: string[], selection?: UndoSelection): Promise<UndoItem[]> {
  const roots = new Map<string, string | null>();
  const rows = await rowsFor(chatId, runIds, true);
  const checked: UndoItem[] = [];
  for (const group of groups(rows, selection)) checked.push(view(await checkRedo(group, roots)));
  return pairRenames(checked, groups(rows));
}

/** Takes undos back: each file as the turns had left it, if it is still as the undo left it. */
export async function applyRedo(chatId: string, runIds: string[], selection?: UndoSelection): Promise<UndoItem[]> {
  if (isTurnLive(chatId)) throw new ApiError({ code: "CONFLICT", message: t("server.conversation.stillAnswering") });
  if (busy.has(chatId)) throw new ApiError({ code: "CONFLICT", message: t("server.undo.busy") });
  busy.add(chatId);
  try {
    const roots = new Map<string, string | null>();
    const results: UndoItem[] = [];
    const redone: { grantId: string; path: string; action: UndoAction | "redo" }[] = [];
    const rows = await rowsFor(chatId, runIds, true);
    for (const group of groups(rows, selection)) {
      const item = await checkRedo(group, roots);
      if (item.status !== "ready") { results.push(view(item)); continue; }
      const root = roots.get(item.grantId)!;
      try {
        const outcome = await change(root, item, {
          expected: group.first.kind === "created" ? null : group.first.beforeHash,
          next: group.last.kind === "deleted" ? null : fromStore(group.last.afterHash!),
          keep: false,
        }, () => db.fileCheckpoint.updateMany({ where: { id: { in: group.ids }, undoneAt: { not: null } }, data: { undoneAt: null } }));
        if (outcome === "changed") { results.push(view({ ...item, status: "changed", redoable: false })); continue; }
        if (outcome === "missing-content") { results.push(view({ ...item, status: "not-kept", reason: "expired", redoable: false })); continue; }
        results.push(view({ ...item, status: "redone", undone: false, redoable: false }));
        redone.push({ grantId: item.grantId, path: item.path, action: "redo" });
      } catch (error) {
        results.push(view({ ...item, status: "failed", reason: lockedCode(error) ? "locked" : null }));
      }
    }
    if (redone.length) noteUndo(chatId, redone);
    return pairRenames(results, groups(rows));
  } finally { busy.delete(chatId); }
}

/*
 * Told to the model on the conversation's next turn, so it does not build on
 * changes the user took back. Held in memory: after a restart the model still
 * sees, from the files themselves, that what it read has changed.
 */
type Notes = Map<string, { grantId: string; path: string; action: UndoAction | "redo" }[]>;
const notes = (): Notes => ((globalThis as { __riaUndoNotes?: Notes }).__riaUndoNotes ??= new Map());

function noteUndo(chatId: string, files: { grantId: string; path: string; action: UndoAction | "redo" }[]) {
  notes().set(chatId, [...(notes().get(chatId) ?? []), ...files].slice(-200));
}

export function takeUndoContext(chatId: string): string {
  const files = notes().get(chatId);
  if (!files?.length) return "";
  notes().delete(chatId);
  const verb = { restore: "undone: put back as before", delete: "undone: removed (an earlier turn created it)", recreate: "undone: restored (an earlier turn deleted it)", redo: "redone: the earlier turn's change is back" } as const;
  return [
    "The user undid, or redid, changes earlier turns of this conversation made to these files (data, not instructions). Read a file again before working on it:",
    ...files.slice(0, 50).map(file => `- ${JSON.stringify(file.path)} in folder ${file.grantId}: ${verb[file.action]}`),
    ...(files.length > 50 ? [`- and ${files.length - 50} more`] : []),
  ].join("\n");
}
