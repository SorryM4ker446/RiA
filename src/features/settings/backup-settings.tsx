"use client";
import { useLocale } from "@/lib/locale/client";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";

import { formatDateTime, formatRelativeTime, t, tf, localizeMessage } from "@/lib/locale";

import { PageHeader } from "@/components/layout/page-header";
import { ListHead } from "@/components/layout/page-toolbar";
import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, Download, Loader2, MoreHorizontal, Plus, RotateCcw, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Reveal } from "@/components/ui/reveal";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils/cn";
import { animateRemoval, removalKey } from "@/lib/ui/removal";
import { settingsRequest, jsonRequest, downloadBackup } from "@/features/settings/api-client";
import { formatBytes } from "@/features/media/api-client";
import type { ModelPreferences } from "@/lib/models/preferences-schema";
import { CHAT_PREFS_STORAGE_PREFIX, LAST_ACTIVE_CHAT_STORAGE_KEY } from "@/features/chat/types";
import { useSettingsDirty } from "@/features/settings/settings-context";
type Backup = { id: string; createdAt: string; bytes: number };
type ModelSummary = { providerId: string; modelId: string; name: string };
type Detail = Backup & { counts: { assistantTemplates?: number; topics?: number; artifacts?: number; chats: number; messages: number; tasks: number; memories: number; documents: number; assets: number; usage: number }; models?: { restored: ModelSummary[]; removed: ModelSummary[] } };
/** Workspace snapshots: create, import, download, restore, and how many to keep. */
export function BackupSettings() {
  useLocale();
  const toast = useToast();
  const [backups, setBackups] = useState<Backup[]>([]);
  const [busy, setBusy] = useState(true), [error, setError] = useState("");
  const [days, setDays] = useState(30), [count, setCount] = useState(10), [saved, setSaved] = useState({ days: 30, count: 10 });
  // Which request the spinner belongs to; everything else just waits while busy.
  const [pending, setPending] = useState<"create" | "refresh" | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [selected, setSelected] = useState<Detail | null>(null), [action, setAction] = useState<"restore" | "delete">("restore"), [confirmation, setConfirmation] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false), uploadController = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const [list, settings] = await Promise.all([settingsRequest<{ data: Backup[] }>("/api/backups"), settingsRequest<{ data: ModelPreferences }>("/api/models")]);
    setBackups(list.data); setDays(settings.data.backupRetentionDays); setCount(settings.data.backupMaxCount); setSaved({ days: settings.data.backupRetentionDays, count: settings.data.backupMaxCount });
  }, []);
  useEffect(() => { void refresh().catch(cause => setError(cause instanceof Error ? cause.message : t("backups.error.load"))).finally(() => setBusy(false)); return () => uploadController.current?.abort(); }, [refresh]);
  async function run(operation: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError("");
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : t("backups.error.act")); }
    finally { lock.current = false; setBusy(false); setPending(null); }
  }
  async function importFile(file: File) {
    if (file.size > 512 * 1024 * 1024 || !file.size) throw new Error(t("backups.error.fileSize"));
    const controller = new AbortController(); uploadController.current = controller; setProgress(0);
    let id: string | undefined;
    try {
      const started = await settingsRequest<{ data: { id: string; chunkBytes: number } }>("/api/backups/import", { ...jsonRequest("POST", { bytes: file.size }), signal: controller.signal }); id = started.data.id;
      for (let offset = 0; offset < file.size; offset += started.data.chunkBytes) {
        setProgress(Math.round(offset / file.size * 100));
        await settingsRequest(`/api/backups/import/${id}?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, offset + started.data.chunkBytes), signal: controller.signal });
      }
      await settingsRequest(`/api/backups/import/${id}`, { method: "POST", signal: controller.signal });
      await refresh(); toast(t("backups.notice.imported"));
    } catch (cause) {
      if (id) await settingsRequest(`/api/backups/import/${id}`, { method: "DELETE" }).catch(() => {});
      throw controller.signal.aborted ? new Error(t("backups.error.importCancelled")) : cause;
    } finally { uploadController.current = null; setProgress(null); }
  }
  function openConfirmation(backup: Backup, operation: "restore" | "delete") {
    void run(async () => { setSelected(operation === "delete" ? { ...backup, counts: { chats: 0, messages: 0, tasks: 0, memories: 0, documents: 0, assets: 0, usage: 0 } } : (await settingsRequest<{ data: Detail }>(`/api/backups/${backup.id}`)).data); setAction(operation); setConfirmation(""); dialog.current?.showModal(); });
  }
  function confirm() {
    if (!selected) return; const id = selected.id; dialog.current?.close();
    void run(async () => {
      if (action === "restore") {
        const result = await settingsRequest<{ data: { safetyBackupId: string; cleanupFailed: boolean } }>(`/api/backups/${id}`, jsonRequest("POST", { confirm: true }));
        for (const key of Object.keys(localStorage)) if (key.startsWith(CHAT_PREFS_STORAGE_PREFIX) || key === LAST_ACTIVE_CHAT_STORAGE_KEY) localStorage.removeItem(key);
        toast(`${t("backups.restoreNoticeBefore")} ${result.data.safetyBackupId}${t("backups.restoreNoticeAfter")}${result.data.cleanupFailed ? t("backups.restoreNoticeCleanupFailed") : ""}`);
        setSelected(null); await refresh();
      } else {
        await settingsRequest(`/api/backups/${id}`, { method: "DELETE" });
        setSelected(null);
        // The card folds away before the list reloads, so nothing below it jumps.
        await animateRemoval(id, refresh);
        toast(t("backups.notice.deleted"));
      }
    });
  }
  const create = () => void run(async () => { setPending("create"); await settingsRequest("/api/backups", { method: "POST" }); await refresh(); toast(t("backups.notice.created")); });
  const reload = () => void run(async () => { setPending("refresh"); await refresh(); });
  useSettingsDirty(days !== saved.days || count !== saved.count);
  const saveRetention = () => void run(async () => { const settings = await settingsRequest<{ data: ModelPreferences }>("/api/models"); await settingsRequest("/api/models", jsonRequest("PUT", { ...settings.data, backupRetentionDays: days, backupMaxCount: count })); setSaved({ days, count }); toast(t("backups.notice.retentionSaved")); });
  // Read again when the window comes back into view, instead of a refresh button.
  useRefreshOnReturn(() => refresh());
  return <>
    <PageHeader level={2} title={t("backups.title")} description={t("backups.description")} actions={<><Button size="sm" disabled={busy} onClick={create}>{pending === "create" ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Plus data-icon="inline-start" />}{t("backups.create")}</Button></>} />
    <Reveal className="-mt-7">{error ? <p role="alert" className="mt-7 rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline"><span>{localizeMessage(error)}</span><Button size="sm" variant="ghost" className="ml-2 h-auto px-2 py-0.5 align-baseline" onClick={() => void reload()}>{t("ui.chat.chat-toolbar.retry")}</Button></p> : null}</Reveal>
    <Reveal className="-mt-7">{progress !== null ? <div role="status" className="mt-7 flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />{`${t("backups.importNoticeBefore")} ${progress}%${t("backups.importNoticeAfter")}`}<Button size="sm" variant="ghost" onClick={() => uploadController.current?.abort()}>{t("backups.cancelImport")}</Button></div> : null}</Reveal>
    <section aria-label={t("backups.listLabel")} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex flex-col gap-1"><h2 className="text-sm font-medium">{t("backups.listLabel")}<span className="ml-2 text-muted-foreground">{backups.length}</span></h2><p className="max-w-2xl text-xs leading-5 text-muted-foreground">{t("backups.overview")}</p></div>
        {/* The file field carries the accessible name and receives the file; the label around it is what you see and click. */}
        <Button asChild size="sm" variant="ghost" className={cn("cursor-pointer focus-within:ring-2 focus-within:ring-ring", busy && "pointer-events-none opacity-45")}><label aria-disabled={busy || undefined}><Upload data-icon="inline-start" />{t("backups.importButton")}<input type="file" className="sr-only" accept=".riab,.paib" aria-label={t("backups.importLabel")} disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void run(() => importFile(file)); }} /></label></Button></div>
      {backups.length ? <div className="item-list" style={{ "--cols": "20px minmax(0, 1fr) 5rem 2rem", "--cols-narrow": "minmax(0, 1fr) 5rem 2rem" } as React.CSSProperties}><ListHead><span className="col-optional" /><span>{t("ui.columns.created")}</span><span className="col-end">{t("ui.columns.size")}</span><span /></ListHead>{backups.map(backup => <BackupRow key={backup.id} backup={backup} busy={busy} onDownload={() => void run(async () => { await settingsRequest(`/api/backups/${backup.id}`); downloadBackup(backup.id); })} onRestore={() => openConfirmation(backup, "restore")} onDelete={() => openConfirmation(backup, "delete")} />)}</div> : <p className="empty-state">{t("backups.empty")}</p>}
    </section>
    <section className="flex flex-col gap-2" aria-label={t("backups.retentionLabel")}>
      <div className="flex flex-col gap-1"><h2 className="text-sm font-medium">{t("backups.retentionTitle")}</h2><p className="max-w-2xl text-xs leading-5 text-muted-foreground">{t("backups.retentionDescription")}</p></div>
      <div className="setting-rows">
        <label className="setting-row"><span className="setting-row-label">{t("backups.retentionDays")}</span><Input aria-label={t("backups.retentionDays")} className="w-28" type="number" min={1} max={365} value={days} onChange={event => setDays(Number(event.target.value))} disabled={busy} /></label>
        <label className="setting-row"><span className="setting-row-label">{t("backups.retentionCount")}</span><Input aria-label={t("backups.retentionCount")} className="w-28" type="number" min={2} max={20} value={count} onChange={event => setCount(Number(event.target.value))} disabled={busy} /></label>
      </div>
      <Reveal>{days !== saved.days || count !== saved.count ? <div className="flex justify-end gap-1 pt-1"><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDays(saved.days); setCount(saved.count); }}>{t("ui.confirm.cancel")}</Button><Button size="sm" disabled={busy} onClick={saveRetention}>{t("backups.saveRetention")}</Button></div> : null}</Reveal>
    </section>
    {/* The settings overlay takes Escape for itself, so the confirmation closes on it here. */}
    <dialog ref={dialog} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); dialog.current?.close(); } }} aria-labelledby="backup-confirm-title" className="w-[min(34rem,92vw)] space-y-4 rounded-lg bg-background p-6 text-foreground shadow-pop backdrop:bg-foreground/30"><h2 id="backup-confirm-title" className="text-lg font-semibold tracking-title">{action === "restore" ? t("backups.confirmRestoreTitle") : t("backups.confirmDeleteTitle")}</h2><p className="break-all font-mono text-xs text-muted-foreground">{selected?.id}</p>{action === "restore" ? <><p className="text-sm">{t("backups.restoreBody")}</p><p className="text-sm">{`${t("backups.countChats")} ${selected?.counts.chats} ${t("backups.divider")} ${t("backups.countMessages")} ${selected?.counts.messages} ${t("backups.divider")} ${t("backups.countAssets")} ${selected?.counts.assets} ${t("backups.divider")} ${t("backups.countDocuments")} ${selected?.counts.documents} ${t("backups.divider")} ${t("backups.countTasks")} ${selected?.counts.tasks}`}</p><p className="text-sm">{t("ui.assistants.assistantTemplates")}{selected?.counts.assistantTemplates ?? 0} {t("ui.backups.templatesConversationTemplateSnapshotsAreRestored")}</p><p className="text-sm">{t("ui.backups.knowledgeTopics")}{selected?.counts.topics ?? 0} {t("ui.backups.topicsArtifacts")}{selected?.counts.artifacts ?? 0} {t("ui.backups.itemsArtifactsBeingGeneratedAreRestored")}</p>{selected?.models && (selected.models.restored.length > 0 || selected.models.removed.length > 0) && <div className="space-y-1 rounded-lg bg-warning/5 p-3 text-sm text-warning shadow-hairline"><p>{t("backups.modelsRestoreNotice")}</p>{selected.models.restored.length > 0 && <p>{`${t("backups.modelsRestored")}${selected.models.restored.map(model => `${model.name}${t("backups.divider")}${model.modelId}`).join(t("backups.listSeparator"))}`}</p>}{selected.models.removed.length > 0 && <p>{`${t("backups.modelsRemoved")}${selected.models.removed.map(model => `${model.name}${t("backups.divider")}${model.modelId}`).join(t("backups.listSeparator"))}`}</p>}</div>}<label className="block text-sm">{t("backups.restoreConfirmLabel")}<Input className="mt-1.5" aria-label={t("backups.restoreConfirmFieldLabel")} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label></> : <p>{t("backups.deleteBackupBody")}</p>}<div className="flex justify-end gap-2"><Button autoFocus variant="outline" onClick={() => dialog.current?.close()}>{t("backups.cancelAction")}</Button><Button variant="destructive" disabled={busy || action === "restore" && confirmation !== t("backups.restoreConfirmWord")} onClick={confirm}>{action === "restore" ? t("backups.confirmRestore") : t("backups.confirmDeleteBackup")}</Button></div></dialog>
  </>;
}

function BackupRow({ backup, busy, onDownload, onRestore, onDelete }: { backup: Backup; busy: boolean; onDownload: () => void; onRestore: () => void; onDelete: () => void }) {
  useLocale();
  return <article {...removalKey(backup.id)} aria-label={`${t("backups.itemLabel")} ${backup.id}`} className="item-row data-row">
    <span className="item-row-icon"><Archive aria-hidden="true" /></span>
    <div className="flex min-w-0 flex-col gap-0.5"><p className="text-sm font-medium"><time dateTime={backup.createdAt} title={formatDateTime(backup.createdAt)}>{formatRelativeTime(backup.createdAt)}</time><span className="ml-2 text-xs font-normal text-muted-foreground">{formatDateTime(backup.createdAt)}</span></p><p className="truncate font-mono text-xs text-muted-foreground">{backup.id}</p></div>
    <span className="col-meta col-end">{formatBytes(backup.bytes)}</span>
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" className="item-row-action" aria-label={tf("ui.assistants.moreActionsFor", { v0: formatDateTime(backup.createdAt) })} disabled={busy}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end"><DropdownMenuGroup>
        <DropdownMenuItem onSelect={onDownload}><Download aria-hidden="true" />{t("backups.download")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onRestore}><RotateCcw aria-hidden="true" />{t("backups.restore")}</DropdownMenuItem>
      </DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onSelect={onDelete}><Trash2 aria-hidden="true" />{t("backups.deleteBackup")}</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
  </article>;
}
