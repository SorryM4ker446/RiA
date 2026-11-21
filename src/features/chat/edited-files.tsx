"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, localizeMessage } from "@/lib/locale";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, FileCode2, FileText, Files, MoreHorizontal, Redo2, Undo2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/ui/reveal";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils/cn";
import { collectEditedFiles, type EditedFile } from "@/lib/terminal/file-change-summary";

const labels = () => ({ created: t("ui.chat.edited-files.added"), modified: t("ui.chat.edited-files.modified"), deleted: t("documents.delete") } as const);
const bytes = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;
function describe(file: EditedFile) {
  if (!file.after) return file.before?.lines === undefined ? t("ui.chat.edited-files.fileDeleted") : tf("ui.chat.edited-files.previouslyLines", { v0: file.before.lines });
  if (!file.before) return file.after.lines === undefined ? bytes(file.after.bytes) : tf("ui.chat.edited-files.lines", { v0: file.after.lines });
  if (file.before.lines !== undefined && file.after.lines !== undefined) return tf("ui.chat.edited-files.lines2", { v0: file.before.lines, v1: file.after.lines });
  return `${bytes(file.before.bytes)} → ${bytes(file.after.bytes)}`;
}

type UndoItem = {
  grantId: string; path: string; action: "restore" | "delete" | "recreate";
  status: "ready" | "changed" | "not-kept" | "folder-unavailable" | "undone" | "redone" | "failed";
  reason?: string | null; pairedWith?: string; undone?: boolean; redoable?: boolean;
};
type FileRef = { grantId: string; path: string };
type UndoRequest = "status" | "preview" | "undo" | "redo-preview" | "redo";
const refKey = (file: FileRef) => `${file.grantId}\0${file.path}`;
const nameOf = (path: string) => path.split("/").at(-1)!;
/** The file, and the other half of its rename if it has one, as the request names them. */
const withPair = (item: UndoItem | undefined, file: FileRef): FileRef[] => [{ grantId: file.grantId, path: file.path }, ...(item?.pairedWith ? [{ grantId: file.grantId, path: item.pairedWith }] : [])];

/** What will happen to a file, or why it will not. */
function actionLine(item: UndoItem) {
  return t(({ restore: "ui.chat.edited-files.undoRestore", delete: "ui.chat.edited-files.undoDelete", recreate: "ui.chat.edited-files.undoRecreate" } as const)[item.action]);
}
function blockedLine(item: UndoItem): string | null {
  if (item.status === "not-kept") {
    const reasons = { "too-large": "ui.chat.edited-files.undoTooLarge", ignored: "ui.chat.edited-files.undoIgnored", "store-full": "ui.chat.edited-files.undoStoreFull", expired: "ui.chat.edited-files.undoExpired" } as const;
    return t(reasons[item.reason as keyof typeof reasons] ?? "ui.chat.edited-files.undoNotKept");
  }
  if (item.status === "changed") return t(item.undone ? "ui.chat.edited-files.redoChanged" : "ui.chat.edited-files.undoChanged");
  if (item.status === "folder-unavailable") return t("ui.chat.edited-files.undoFolderUnavailable");
  if (item.status === "failed") return t("ui.chat.edited-files.undoFileFailed");
  return null;
}

async function requestUndo(chatId: string, runIds: string[], action: UndoRequest, files?: FileRef[]): Promise<UndoItem[]> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(chatId)}/undo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runIds, action, ...(files ? { files } : {}) }) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error?.message ?? t("ui.chat.edited-files.undoFailed"));
  return payload.data.files as UndoItem[];
}

/**
 * The files of an undo with a box each. Every file that can be undone starts
 * ticked; one that changed since, or whose earlier content was not kept, is
 * listed with the reason and cannot be ticked. The two halves of a rename are
 * ticked together. The confirming button says how many files it will undo.
 */
function UndoDialog({ open, items, loading, onCancel, onConfirm }: {
  open: boolean; items: UndoItem[]; loading: boolean; onCancel: () => void; onConfirm: (files: FileRef[]) => void;
}) {
  useLocale();
  const ready = items.filter(item => item.status === "ready");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  // Until the user changes something, every file that can be undone is ticked.
  const chosen = picked ?? new Set(ready.map(refKey));
  const toggle = (item: UndoItem, on: boolean) => {
    const next = new Set(chosen);
    for (const file of withPair(item, item)) { if (on) next.add(refKey(file)); else next.delete(refKey(file)); }
    setPicked(next);
  };
  const count = ready.filter(item => chosen.has(refKey(item))).length;
  return <AlertDialog open={open} onOpenChange={next => { if (!next) { setPicked(null); onCancel(); } }}>
    <AlertDialogContent className="edited-files-dialog">
      <AlertDialogHeader>
        <AlertDialogTitle>{t("ui.chat.edited-files.undoTitle")}</AlertDialogTitle>
        <AlertDialogDescription>{t("ui.chat.edited-files.undoDescription")}</AlertDialogDescription>
      </AlertDialogHeader>
      <ul className="edited-files-choices chat-list-scroll" aria-busy={loading || undefined}>
        {items.map(item => {
          const id = `undo-${refKey(item)}`;
          const canPick = !loading && item.status === "ready";
          const blocked = loading ? null : blockedLine(item);
          return <li key={refKey(item)} className="edited-files-choice" data-blocked={blocked ? "" : undefined}>
            <Checkbox id={id} disabled={!canPick} checked={canPick && chosen.has(refKey(item))} onCheckedChange={value => toggle(item, value === true)} aria-label={item.path} />
            <label htmlFor={canPick ? id : undefined} className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-foreground">{item.path}</span>
              <span className="truncate text-xs text-muted-foreground">
                {loading ? t("ui.chat.edited-files.undoChecking") : blocked ?? actionLine(item)}
                {!loading && item.pairedWith ? ` · ${tf("ui.chat.edited-files.undoRenamePair", { path: nameOf(item.pairedWith) })}` : ""}
              </span>
            </label>
          </li>;
        })}
      </ul>
      <AlertDialogFooter className="items-center sm:justify-between">
        <span className="text-xs text-muted-foreground">{loading ? null : t("ui.chat.edited-files.undoReversible")}</span>
        <div className="flex gap-2">
          <AlertDialogCancel>{t("ui.confirm.cancel")}</AlertDialogCancel>
          <Button size="sm" disabled={loading || count === 0} onClick={() => { const files = ready.filter(item => chosen.has(refKey(item))).map(({ grantId, path }) => ({ grantId, path })); setPicked(null); onConfirm(files); }}>
            {loading ? <Spinner data-icon="inline-start" /> : <Undo2 data-icon="inline-start" />}
            {loading ? t("ui.chat.edited-files.undoChecking") : tf("ui.chat.edited-files.undoCount", { count })}
          </Button>
        </div>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}

export function EditedFiles({ parts, chatId = null, runIds = [] }: { parts: readonly unknown[]; chatId?: string | null; runIds?: string[] }) {
  useLocale();
  const { files, complete } = collectEditedFiles(parts);
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const openingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // Where each file's undo stands, read from the records once the card is on screen.
  const [states, setStates] = useState<Map<string, UndoItem> | null>(null);
  // Files with an undo or redo under way, and a per-file note left by the last attempt.
  const [working, setWorking] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Map<string, string>>(new Map());
  const [dialog, setDialog] = useState<{ items: UndoItem[]; loading: boolean } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const runKey = runIds.join(",");
  const canUndo = !!chatId && runIds.length > 0 && files.length > 0;

  const refresh = useCallback(async () => {
    if (!chatId || !runKey) return;
    const items = await requestUndo(chatId, runKey.split(","), "status").catch(() => null);
    if (items) setStates(new Map(items.map(item => [refKey(item), item])));
  }, [chatId, runKey]);

  useEffect(() => {
    const node = cardRef.current;
    if (!canUndo || !node) return;
    // A long conversation has many of these cards; each reads its state only when it comes into view.
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void refresh();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [canUndo, refresh]);

  if (!files.length && complete) return null;
  // Nothing confirmed changed, but the count could not be finished: a "0" would read as "nothing changed".
  if (!files.length) return <p className="edited-files-incomplete mt-5 text-xs text-muted-foreground" role="status">{t("ui.chat.edited-files.statsIncomplete")}</p>;
  const canOpen = typeof window !== "undefined" && !!window.riaDesktop?.openFile;
  const stateOf = (file: FileRef) => states?.get(refKey(file));
  const undoable = states ? [...states.values()].filter(item => item.status === "ready") : [];
  const redoable = states ? [...states.values()].filter(item => item.undone && item.redoable) : [];

  async function open(file: EditedFile) {
    const bridge = window.riaDesktop;
    if (!bridge?.openFile || openingRef.current) return;
    openingRef.current = true;
    setOpening(refKey(file));
    setError(null);
    try {
      const response = await fetch("/api/terminal/files/resolve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grantId: file.grantId, path: file.path }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? t("ui.chat.edited-files.couldNotOpenFile"));
      if (!(await bridge.openFile(payload.data.absolutePath)).opened) throw new Error(t("ui.chat.edited-files.theSystemCouldNotOpenThis"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("ui.chat.edited-files.couldNotOpenFile")); }
    finally { openingRef.current = false; setOpening(null); }
  }

  /**
   * Undoes or redoes the given files at once: both can be taken back, so no
   * confirmation is asked. The result is a toast with the way back; a file
   * that could not be done keeps a note on its row.
   */
  async function run(kind: "undo" | "redo", targets: FileRef[]) {
    if (!chatId || !targets.length) return;
    const keys = targets.map(refKey);
    setWorking(current => new Set([...current, ...keys]));
    setError(null);
    try {
      const results = await requestUndo(chatId, runIds, kind, targets);
      const done = results.filter(item => item.status === (kind === "undo" ? "undone" : "redone"));
      setNotes(current => {
        const next = new Map(current);
        for (const item of results) {
          const blocked = blockedLine(item);
          if (blocked) next.set(refKey(item), blocked); else next.delete(refKey(item));
        }
        return next;
      });
      await refresh();
      if (!done.length) return;
      const back = done.map(({ grantId, path }) => ({ grantId, path }));
      const single = done.length === 1 || (done.length === 2 && !!done[0].pairedWith);
      const title = kind === "undo"
        ? single ? tf("ui.chat.edited-files.undoneOne", { name: nameOf(done[0].path) }) : tf("ui.chat.edited-files.undoDone", { count: done.length })
        : single ? tf("ui.chat.edited-files.redoneOne", { name: nameOf(done[0].path) }) : tf("ui.chat.edited-files.redoDone", { count: done.length });
      const left = results.length - done.length;
      toast({
        title,
        ...(left ? { description: tf("ui.chat.edited-files.undoLeft", { count: left }) } : {}),
        // The way back names exactly these files, whatever is on screen by then.
        action: { label: t(kind === "undo" ? "ui.chat.edited-files.redo" : "ui.chat.edited-files.undoShort"), run: () => void run(kind === "undo" ? "redo" : "undo", back) },
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("ui.chat.edited-files.undoFailed")); }
    finally { setWorking(current => { const next = new Set(current); for (const key of keys) next.delete(key); return next; }); }
  }

  /** Several files: a list to choose from first, checked against the files as they are now. */
  async function chooseAndUndo() {
    if (!chatId) return;
    const listed = undoable.length ? undoable : [...(states?.values() ?? [])].filter(item => !item.undone);
    setDialog({ items: listed, loading: true });
    setError(null);
    try {
      const items = await requestUndo(chatId, runIds, "preview");
      setDialog(current => current && { items, loading: false });
      // What the check found stays on the rows too, after the dialog closes.
      setNotes(current => {
        const next = new Map(current);
        for (const item of items) { const blocked = blockedLine(item); if (blocked) next.set(refKey(item), blocked); else next.delete(refKey(item)); }
        return next;
      });
    } catch (cause) {
      setDialog(null);
      setError(cause instanceof Error ? cause.message : t("ui.chat.edited-files.undoFailed"));
    }
  }

  const busy = working.size > 0;
  const headerAction = !canUndo || !states ? null
    : undoable.length > 1 ? { label: t("ui.chat.edited-files.undo"), icon: Undo2, act: () => void chooseAndUndo() }
    : undoable.length === 1 ? { label: t("ui.chat.edited-files.undo"), icon: Undo2, act: () => void run("undo", withPair(undoable[0], undoable[0])) }
    : redoable.length ? { label: t("ui.chat.edited-files.redoAll"), icon: Redo2, act: () => void run("redo", redoable.map(({ grantId, path }) => ({ grantId, path }))) }
    : null;
  const undoneCount = states ? [...states.values()].filter(item => item.undone).length : 0;

  const renderRow = (file: (typeof files)[number]) => {
          const key = `${file.grantId}:${file.cwd}:${file.path}`;
          const filename = nameOf(file.path);
          const directory = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
          const Icon = /\.(md|txt|csv|json)$/i.test(filename) ? FileText : FileCode2;
          const state = stateOf(file);
          const undone = !!state?.undone;
          const note = notes.get(refKey(file));
          const rowBusy = working.has(refKey(file));
          // The row's one menu action: undo while the change stands, redo once it is undone.
          const menu = !canUndo || !state ? null
            : !undone && state.status === "ready" ? { label: t("ui.chat.edited-files.undoFile"), icon: Undo2, act: () => void run("undo", withPair(state, file)) }
            : undone && state.redoable ? { label: t("ui.chat.edited-files.redoFile"), icon: Redo2, act: () => void run("redo", withPair(state, file)) }
            : null;
          const blocked = !menu && state && !undone ? blockedLine(state) : null;
          return <li key={key} className="edited-files-row" data-undone={undone ? "" : undefined}>
            <Button type="button" variant="ghost" className="h-auto min-w-0 flex-1 justify-start gap-2 px-2 py-2" disabled={!canOpen || !(undone ? file.before : file.after) || opening !== null} aria-label={tf("ui.chat.edited-files.openFile", { v0: file.path })} title={`${file.cwd}/${file.path} · ${canOpen ? t("ui.chat.edited-files.openInDefaultApplication") : t("ui.chat.edited-files.openInDesktopApp")}`} onClick={() => void open(file)}>
              <Icon data-icon="inline-start" />
              <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left">
                <span className="flex w-full min-w-0 items-center gap-2">
                  <span className={cn("truncate font-medium", undone && "text-muted-foreground")}>{filename}</span>
                  {undone ? <Badge variant="secondary">{t("ui.chat.edited-files.undoneBadge")}</Badge>
                    : <Badge variant={file.kind === "created" ? "success" : file.kind === "deleted" ? "danger" : "outline"}>{labels()[file.kind]}</Badge>}
                </span>
                <span className="max-w-full truncate text-xs font-normal text-muted-foreground">{directory ? `${directory} · ` : ""}{undone ? t("ui.chat.edited-files.undoneMeta") : describe(file)}</span>
              </span>
              {opening === refKey(file) || rowBusy ? <Spinner data-icon="inline-end" /> : (undone ? file.before : file.after) && canOpen ? <ExternalLink data-icon="inline-end" /> : null}
            </Button>
            {canUndo ? <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button type="button" size="icon-sm" variant="ghost" className="edited-files-more shrink-0 text-muted-foreground" disabled={rowBusy || !states} aria-label={tf("ui.chat.edited-files.fileActions", { path: file.path })}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-w-72"><DropdownMenuGroup>
                {menu ? <DropdownMenuItem onSelect={menu.act}><menu.icon aria-hidden="true" />{menu.label}</DropdownMenuItem>
                  : <DropdownMenuItem disabled><Undo2 aria-hidden="true" /><span className="flex min-w-0 flex-col"><span>{t("ui.chat.edited-files.undoFile")}</span><span className="text-xs text-muted-foreground">{blocked ?? (undone ? t("ui.chat.edited-files.redoUnavailable") : t("ui.chat.edited-files.undoNotKept"))}</span></span></DropdownMenuItem>}
              </DropdownMenuGroup></DropdownMenuContent>
            </DropdownMenu> : null}
            <Reveal className="edited-files-note">{note ? <p className="px-2 pb-1 text-xs text-muted-foreground">{note}</p> : null}</Reveal>
          </li>;
  };
  return <div ref={cardRef} className="mt-5"><Card className="edited-files" role="region" aria-label={t("ui.chat.edited-files.recentlyEditedFiles")}>
    <CardHeader className="gap-0 px-3 pb-1 pt-3">
      <CardTitle className="flex min-h-7 items-center gap-2 text-[13px] font-medium"><Files aria-hidden="true" className="size-4 text-muted-foreground" />{t("ui.chat.edited-files.recentlyEditedFiles")}<Badge variant="secondary">{files.length}</Badge>
        {undoneCount ? <span className="text-xs font-normal text-muted-foreground">{tf("ui.chat.edited-files.undoneCount", { count: undoneCount })}</span> : null}
        {headerAction ? <Button type="button" variant="ghost" size="sm" className="ml-auto h-7 text-xs font-normal text-muted-foreground" disabled={busy || !!dialog} onClick={headerAction.act}>
          {busy ? <Spinner data-icon="inline-start" /> : <headerAction.icon data-icon="inline-start" />}{headerAction.label}
        </Button> : null}
      </CardTitle>
      <CardDescription className="sr-only">{["created", "modified", "deleted"].flatMap(kind => {
        const count = files.filter(file => file.kind === kind).length;
        return count ? [tf("ui.chat.edited-files.items", { v0: labels()[kind as keyof typeof labels], v1: count })] : [];
      }).join(" · ")}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-0 px-1.5 pb-1.5">
      <ul className="flex min-w-0 flex-col gap-1">
        {files.slice(0, 3).map(renderRow)}
      </ul>
      {/* The rest unfold under the first three rather than jumping in. */}
      <Reveal>{expanded && files.length > 3 ? <ul className="flex min-w-0 flex-col gap-1 pt-1">{files.slice(3).map(renderRow)}</ul> : null}</Reveal>
      {files.length > 3 ? <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronUp data-icon="inline-start" /> : <ChevronDown data-icon="inline-start" />}{expanded ? t("ui.chat.edited-files.collapse") : tf("ui.chat.edited-files.showMoreFiles", { v0: files.length - 3 })}</Button> : null}
      {!complete || !canOpen ? <p className="px-2 py-1 text-xs text-muted-foreground">{!complete ? t("ui.chat.edited-files.statsIncomplete") : t("ui.chat.edited-files.openFilesInTheDesktopApp")}</p> : null}
      <Reveal>{error ? <Alert variant="destructive"><AlertDescription>{localizeMessage(error)}</AlertDescription></Alert> : null}</Reveal>
    </CardContent>
    {canUndo ? <UndoDialog open={!!dialog} items={dialog?.items ?? []} loading={dialog?.loading ?? false}
      onCancel={() => setDialog(null)} onConfirm={files => { setDialog(null); void run("undo", files); }} /> : null}
  </Card></div>;
}
