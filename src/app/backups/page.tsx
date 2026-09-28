"use client";
import Link from "next/link";
import { BackToChatLink } from "@/components/layout/back-to-chat-link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { RefreshButton } from "@/components/ui/refresh-button";
import { settingsRequest, jsonRequest, downloadBackup } from "@/features/settings/api-client";
import { formatBytes } from "@/features/media/api-client";
import type { ModelPreferences } from "@/lib/models/preferences-schema";
import { CHAT_PREFS_STORAGE_PREFIX, LAST_ACTIVE_CHAT_STORAGE_KEY } from "@/features/chat/types";
import { formatDateTime, t } from "@/lib/locale";

type Backup = { id: string; createdAt: string; bytes: number };
type ModelSummary = { providerId: string; modelId: string; name: string };
type Detail = Backup & { counts: { chats: number; messages: number; tasks: number; memories: number; documents: number; assets: number; usage: number }; models?: { restored: ModelSummary[]; removed: ModelSummary[] } };
export default function BackupsPage() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [days, setDays] = useState(30), [count, setCount] = useState(10);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Detail | null>(null), [action, setAction] = useState<"restore" | "delete">("restore"), [confirmation, setConfirmation] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false), uploadController = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const [list, settings] = await Promise.all([settingsRequest<{ data: Backup[] }>("/api/backups"), settingsRequest<{ data: ModelPreferences }>("/api/models")]);
    setBackups(list.data); setDays(settings.data.backupRetentionDays); setCount(settings.data.backupMaxCount);
  }, []);
  useEffect(() => { void refresh().catch(cause => setError(cause instanceof Error ? cause.message : t("backups.error.load"))).finally(() => setBusy(false)); return () => uploadController.current?.abort(); }, [refresh]);
  async function run(operation: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (cause) { setNotice(""); setError(cause instanceof Error ? cause.message : t("backups.error.act")); }
    finally { lock.current = false; setBusy(false); }
  }
  async function importFile(file: File) {
    if (file.size > 512 * 1024 * 1024 || !file.size) throw new Error(t("backups.error.fileSize"));
    const controller = new AbortController(); uploadController.current = controller; setImporting(true);
    let id: string | undefined;
    try {
      const started = await settingsRequest<{ data: { id: string; chunkBytes: number } }>("/api/backups/import", { ...jsonRequest("POST", { bytes: file.size }), signal: controller.signal }); id = started.data.id;
      for (let offset = 0; offset < file.size; offset += started.data.chunkBytes) {
        setNotice(`${t("backups.importNoticeBefore")} ${Math.round(offset / file.size * 100)}%${t("backups.importNoticeAfter")}`);
        await settingsRequest(`/api/backups/import/${id}?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, offset + started.data.chunkBytes), signal: controller.signal });
      }
      await settingsRequest(`/api/backups/import/${id}`, { method: "POST", signal: controller.signal });
      await refresh(); setNotice(t("backups.notice.imported"));
    } catch (cause) {
      if (id) await settingsRequest(`/api/backups/import/${id}`, { method: "DELETE" }).catch(() => {});
      throw controller.signal.aborted ? new Error(t("backups.error.importCancelled")) : cause;
    } finally { uploadController.current = null; setImporting(false); }
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
        setNotice(`${t("backups.restoreNoticeBefore")} ${result.data.safetyBackupId}${t("backups.restoreNoticeAfter")}${result.data.cleanupFailed ? t("backups.restoreNoticeCleanupFailed") : ""}`);
      } else { await settingsRequest(`/api/backups/${id}`, { method: "DELETE" }); setNotice(t("backups.notice.deleted")); }
      setSelected(null); await refresh();
    });
  }
  return <main className="mx-auto max-w-4xl space-y-8 px-4 py-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-headline">{t("backups.title")}</h1><p className="mt-2 text-sm text-muted-foreground">{t("backups.description")}</p></div><BackToChatLink /></header>
    <p className="text-sm text-muted-foreground">{t("backups.overview")}</p>
    <div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={() => void run(async () => { setNotice(t("backups.notice.creating")); await settingsRequest("/api/backups", { method: "POST" }); await refresh(); setNotice(t("backups.notice.created")); })}>{t("backups.create")}</Button><RefreshButton disabled={busy} onClick={() => void run(refresh)} refreshing={busy} label={t("backups.refresh")} /></div><div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed bg-background/40 p-4"><span className="shrink-0 text-sm font-medium tracking-label">{t("backups.importLabel")}</span><FileInput accept=".paib" aria-label={t("backups.importLabel")} buttonLabel={t("backups.importButton")} disabled={busy} className="min-w-0 max-w-sm flex-1" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void run(() => importFile(file)); }} />{importing && <Button variant="outline" onClick={() => uploadController.current?.abort()}>{t("backups.cancelImport")}</Button>}</div>
    {error && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{error}</p>}{notice && <p role="status" className="break-words text-sm text-muted-foreground">{notice}</p>}
    <section className="space-y-3 rounded-lg bg-card p-5 shadow-card" aria-label={t("backups.retentionLabel")}><h2 className="text-base font-semibold tracking-title">{t("backups.retentionTitle")}</h2><p className="text-sm text-muted-foreground">{t("backups.retentionDescription")}</p><div className="flex flex-wrap items-end gap-3"><label className="text-sm">{t("backups.retentionDays")}<Input aria-label={t("backups.retentionDays")} className="w-28" type="number" min={1} max={365} value={days} onChange={event => setDays(Number(event.target.value))} disabled={busy} /></label><label className="text-sm">{t("backups.retentionCount")}<Input aria-label={t("backups.retentionCount")} className="w-28" type="number" min={2} max={20} value={count} onChange={event => setCount(Number(event.target.value))} disabled={busy} /></label><Button disabled={busy} variant="outline" onClick={() => void run(async () => { const settings = await settingsRequest<{ data: ModelPreferences }>("/api/models"); await settingsRequest("/api/models", jsonRequest("PUT", { ...settings.data, backupRetentionDays: days, backupMaxCount: count })); setNotice(t("backups.notice.retentionSaved")); })}>{t("backups.saveRetention")}</Button></div></section>
    <section aria-label={t("backups.listLabel")} className="space-y-3">{backups.map(backup => <article key={backup.id} aria-label={`${t("backups.itemLabel")} ${backup.id}`} className="space-y-3 rounded-lg bg-card p-5 shadow-card"><p className="font-medium tracking-label">{formatDateTime(backup.createdAt)} · {formatBytes(backup.bytes)}</p><p className="break-all font-mono text-xs text-muted-foreground">{backup.id}</p><div className="flex flex-wrap gap-2"><Button disabled={busy} variant="outline" onClick={() => void run(async () => { await settingsRequest(`/api/backups/${backup.id}`); downloadBackup(backup.id); })}>{t("backups.download")}</Button><Button disabled={busy} variant="outline" onClick={() => openConfirmation(backup, "restore")}>{t("backups.restore")}</Button><Button disabled={busy} variant="destructive" onClick={() => openConfirmation(backup, "delete")}>{t("backups.deleteBackup")}</Button></div></article>)}{!backups.length && <p className="text-sm text-muted-foreground">{t("backups.empty")}</p>}</section>
    <dialog ref={dialog} aria-labelledby="backup-confirm-title" className="w-[min(34rem,92vw)] space-y-4 rounded-lg bg-background p-6 text-foreground shadow-pop backdrop:bg-foreground/30"><h2 id="backup-confirm-title" className="text-lg font-semibold tracking-title">{action === "restore" ? t("backups.confirmRestoreTitle") : t("backups.confirmDeleteTitle")}</h2><p className="break-all font-mono text-xs text-muted-foreground">{selected?.id}</p>{action === "restore" ? <><p className="text-sm">{t("backups.restoreBody")}</p><p className="text-sm">{`${t("backups.countChats")} ${selected?.counts.chats} ${t("backups.divider")} ${t("backups.countMessages")} ${selected?.counts.messages} ${t("backups.divider")} ${t("backups.countAssets")} ${selected?.counts.assets} ${t("backups.divider")} ${t("backups.countDocuments")} ${selected?.counts.documents} ${t("backups.divider")} ${t("backups.countTasks")} ${selected?.counts.tasks}`}</p>{selected?.models && (selected.models.restored.length > 0 || selected.models.removed.length > 0) && <div className="space-y-1 rounded-lg bg-warning/5 p-3 text-sm text-warning shadow-hairline"><p>{t("backups.modelsRestoreNotice")}</p>{selected.models.restored.length > 0 && <p>{`${t("backups.modelsRestored")}${selected.models.restored.map(model => `${model.name}${t("backups.divider")}${model.modelId}`).join(t("backups.listSeparator"))}`}</p>}{selected.models.removed.length > 0 && <p>{`${t("backups.modelsRemoved")}${selected.models.removed.map(model => `${model.name}${t("backups.divider")}${model.modelId}`).join(t("backups.listSeparator"))}`}</p>}</div>}<label className="block text-sm">{t("backups.restoreConfirmLabel")}<Input className="mt-1.5" aria-label={t("backups.restoreConfirmFieldLabel")} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label></> : <p>{t("backups.deleteBackupBody")}</p>}<div className="flex justify-end gap-2"><Button autoFocus variant="outline" onClick={() => dialog.current?.close()}>{t("backups.cancelAction")}</Button><Button variant="destructive" disabled={busy || action === "restore" && confirmation !== t("backups.restoreConfirmWord")} onClick={confirm}>{action === "restore" ? t("backups.confirmRestore") : t("backups.confirmDeleteBackup")}</Button></div></dialog>
  </main>;
}
