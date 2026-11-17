"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, FolderPlus, FolderSync, MoreHorizontal, RotateCw, Trash2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Reveal } from "@/components/ui/reveal";
import { Spinner } from "@/components/ui/spinner";
import { Status } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";
import { formatRelativeTime, localizeMessage, t, tf } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { animateRemoval, removalKey } from "@/lib/ui/removal";
import { documentRequest } from "./document-client";

export type KnowledgeFolder = {
  id: string; label: string; path: string; collection: string | null; status: "pending" | "synced" | "missing" | "failed"; error: string | null;
  lastSyncedAt: string | null; syncing: boolean; documents: number; failed: number; skipped: number;
  problems: Array<{ relativePath: string; status: string; error: string | null }>;
};

const listFolders = (signal?: AbortSignal) => documentRequest<KnowledgeFolder[]>("/api/knowledge-folders", { signal });

function folderStatus(folder: KnowledgeFolder): { label: string; tone: "neutral" | "success" | "warning"; detail?: string } {
  if (folder.syncing) return { label: t("knowledgeFolders.status.syncing"), tone: "neutral" };
  if (folder.status === "missing") return { label: t("knowledgeFolders.status.missing"), tone: "warning", detail: folder.error ?? undefined };
  if (folder.status === "failed") return { label: t("knowledgeFolders.status.failed"), tone: "warning", detail: folder.error ?? undefined };
  if (folder.status === "pending") return { label: t("knowledgeFolders.status.pending"), tone: "neutral" };
  if (folder.failed + folder.skipped) return { label: tf("knowledgeFolders.status.someLeftOut", { count: folder.failed + folder.skipped }), tone: "warning", detail: folder.error ?? undefined };
  return { label: t("knowledgeFolders.status.synced"), tone: "success", detail: folder.error ?? undefined };
}

/**
 * Folders the knowledge base keeps in step with. A folder is chosen in the
 * desktop folder dialog and only read: its files become documents, change when
 * they change, and go when they leave it. `onChanged` refreshes the document
 * list once a scan has finished.
 */
export function KnowledgeFolders({ collections, onChanged }: { collections: string[]; onChanged: () => void }) {
  useLocale();
  const confirm = useConfirm();
  const toast = useToast();
  const [folders, setFolders] = useState<KnowledgeFolder[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [collection, setCollection] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [canChoose, setCanChoose] = useState(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  async function refresh(signal?: AbortSignal) {
    const next = await listFolders(signal);
    if (signal?.aborted) return;
    setFolders(previous => {
      // A scan that has finished since the last look may have added, changed or removed documents,
      // also one so quick it was never seen running.
      if (previous.some(folder => { const now = next.find(item => item.id === folder.id); return now && ((folder.syncing && !now.syncing) || folder.lastSyncedAt !== now.lastSyncedAt); })) changed.current();
      return next;
    });
  }
  useEffect(() => {
    setCanChoose(Boolean(window.riaDesktop?.chooseFolder));
    const controller = new AbortController();
    refresh(controller.signal).catch(() => {});
    return () => controller.abort();
  }, []);
  const syncing = folders.some(folder => folder.syncing);
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 2_000);
    return () => clearInterval(timer);
  }, [syncing]);

  async function act(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : t("knowledgeFolders.failed")); }
    finally { setBusy(false); }
  }
  // Only a folder the person pointed at in the dialog is synced, never a typed path.
  async function choose() {
    const bridge = window.riaDesktop;
    if (!bridge?.chooseFolder || busy) return;
    const picked = await bridge.chooseFolder().catch(() => null);
    if (picked && !picked.canceled && picked.path) { setChosen(picked.path); setCollection(""); setError(""); }
  }
  function add() {
    if (!chosen) return;
    void act(async () => {
      await documentRequest("/api/knowledge-folders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: chosen, collection: collection.trim() || null }) });
      setChosen(null);
      toast(t("knowledgeFolders.added"));
      await refresh();
    });
  }
  function sync(folder: KnowledgeFolder) {
    void act(async () => { await documentRequest(`/api/knowledge-folders/${folder.id}/sync`, { method: "POST" }); await refresh(); });
  }
  async function remove(folder: KnowledgeFolder, documents: "keep" | "delete") {
    const approved = await confirm(documents === "delete"
      ? { title: t("knowledgeFolders.deleteTitle"), description: tf("knowledgeFolders.deleteDescription", { folder: folder.label, count: folder.documents }), action: t("knowledgeFolders.deleteAction"), destructive: true }
      : { title: t("knowledgeFolders.stopTitle"), description: tf("knowledgeFolders.stopDescription", { folder: folder.label }), action: t("knowledgeFolders.stopAction") });
    if (!approved) return;
    void act(async () => {
      await documentRequest(`/api/knowledge-folders/${folder.id}?documents=${documents}`, { method: "DELETE" });
      await animateRemoval(folder.id, refresh);
      toast(documents === "delete" ? t("knowledgeFolders.deleted") : t("knowledgeFolders.stopped"));
      changed.current();
    });
  }

  if (!canChoose && !folders.length) return null;
  return <section aria-label={t("knowledgeFolders.title")} className="flex min-w-0 flex-col gap-2">
    <header className="flex items-center justify-between gap-2">
      <div className="flex items-baseline gap-2"><h3 className="text-sm font-medium">{t("knowledgeFolders.title")}</h3><span className="text-xs text-muted-foreground">{t("knowledgeFolders.subtitle")}</span></div>
      {canChoose ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void choose()}><FolderPlus data-icon="inline-start" />{t("knowledgeFolders.add")}</Button> : null}
    </header>
    <Reveal className="-mt-2">{chosen ? <form className="knowledge-import-card mt-2" aria-label={t("knowledgeFolders.addTitle")} onSubmit={event => { event.preventDefault(); add(); }}>
      <FieldGroup className="grid items-end gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
        <Field className="min-w-0 gap-2"><FieldLabel className="text-xs">{t("knowledgeFolders.folderLabel")}</FieldLabel><p className="truncate text-sm leading-9" title={chosen}>{chosen}</p></Field>
        <Field className="min-w-0 gap-2"><FieldLabel className="text-xs" htmlFor="knowledge-folder-collection">{t("documents.collectionLabel")}</FieldLabel><Input id="knowledge-folder-collection" list="knowledge-folder-collections" maxLength={40} disabled={busy} value={collection} onChange={event => setCollection(event.target.value)} placeholder={t("documents.collectionPlaceholder")} /><datalist id="knowledge-folder-collections">{collections.map(value => <option key={value} value={value} />)}</datalist></Field>
        <div className="flex items-center gap-1">
          <Button type="submit" disabled={busy}>{busy ? <Spinner data-icon="inline-start" /> : <FolderSync data-icon="inline-start" />}{t("knowledgeFolders.start")}</Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setChosen(null)}>{t("knowledge.cancelEdit")}</Button>
        </div>
      </FieldGroup>
      <p className="text-xs leading-6 text-muted-foreground">{t("knowledgeFolders.explain")}</p>
    </form> : null}</Reveal>
    {error ? <p role="alert" className="text-xs text-destructive">{localizeMessage(error)}</p> : null}
    {folders.length ? <ul aria-label={t("knowledgeFolders.title")} className="item-list" style={{ "--cols": "20px minmax(0, 1fr) 9rem 4rem auto", "--cols-narrow": "minmax(0, 1fr) 9rem auto" } as React.CSSProperties}>
      {folders.map(folder => {
        const status = folderStatus(folder);
        return <li key={folder.id} className="item-row data-row min-w-0" {...removalKey(folder.id)}>
          <span className="item-row-icon"><Folder aria-hidden="true" /></span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-medium">{folder.label}</span>{folder.collection ? <span className="min-w-0 truncate rounded bg-muted px-1.5 text-xs leading-5 text-muted-foreground">{folder.collection}</span> : null}</div>
            <span className="truncate text-xs text-muted-foreground" title={folder.path}>{folder.path} · {tf("knowledgeFolders.documents", { count: folder.documents })}</span>
            {folder.problems.length ? <details className="group text-xs text-muted-foreground"><summary className="flex cursor-pointer items-center gap-1 py-0.5">{t("knowledgeFolders.problems")}<ChevronRight className="size-3 transition-transform duration-[--dur-fast] group-open:rotate-90" aria-hidden="true" /></summary>
              <ul className="flex flex-col gap-0.5 py-1">{folder.problems.map(problem => <li key={problem.relativePath} className="flex min-w-0 gap-2"><span className="min-w-0 truncate" title={problem.relativePath}>{problem.relativePath}</span><span className="min-w-0 truncate" title={problem.error ? localizeMessage(problem.error) : undefined}>{problem.error ? localizeMessage(problem.error) : ""}</span></li>)}</ul>
            </details> : null}
          </div>
          <span className="col-meta"><Status tone={status.tone} title={status.detail ? localizeMessage(status.detail) : undefined}>{folder.syncing ? <Spinner aria-hidden="true" className="size-3" /> : null}{status.label}</Status></span>
          <span className="col-meta col-optional">{folder.lastSyncedAt ? <time dateTime={folder.lastSyncedAt}>{formatRelativeTime(folder.lastSyncedAt)}</time> : null}</span>
          <div className="flex shrink-0 items-center justify-end">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={tf("ui.assistants.moreActionsFor", { v0: folder.label })} disabled={busy}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem aria-label={`${t("knowledgeFolders.syncNow")} ${folder.label}`} disabled={folder.syncing} onSelect={() => sync(folder)}><RotateCw aria-hidden="true" />{t("knowledgeFolders.syncNow")}</DropdownMenuItem>
                <DropdownMenuItem aria-label={`${t("knowledgeFolders.stopAction")} ${folder.label}`} onSelect={() => void remove(folder, "keep")}><Unlink aria-hidden="true" />{t("knowledgeFolders.stopAction")}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" aria-label={`${t("knowledgeFolders.deleteAction")} ${folder.label}`} onSelect={() => void remove(folder, "delete")}><Trash2 aria-hidden="true" />{t("knowledgeFolders.deleteAction")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </li>;
      })}
    </ul> : <p className="text-xs leading-6 text-muted-foreground">{t("knowledgeFolders.empty")}</p>}
  </section>;
}
