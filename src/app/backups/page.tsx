"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { settingsRequest, jsonRequest, downloadBackup } from "@/features/settings/api-client";
import { formatBytes } from "@/features/media/api-client";
import type { ModelPreferences } from "@/lib/models/preferences-schema";
import { CHAT_PREFS_STORAGE_PREFIX, LAST_ACTIVE_CHAT_STORAGE_KEY } from "@/features/chat/types";

type Backup = { id: string; createdAt: string; bytes: number };
type Detail = Backup & { counts: Record<string, number> };
export default function BackupsPage() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [days, setDays] = useState(30), [count, setCount] = useState(10);
  const [selected, setSelected] = useState<Detail | null>(null), [action, setAction] = useState<"restore" | "delete">("restore"), [confirmation, setConfirmation] = useState("");
  const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false), uploadController = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const [list, settings] = await Promise.all([settingsRequest<{ data: Backup[] }>("/api/backups"), settingsRequest<{ data: ModelPreferences }>("/api/models")]);
    setBackups(list.data); setDays(settings.data.backupRetentionDays); setCount(settings.data.backupMaxCount);
  }, []);
  useEffect(() => { void refresh().catch(cause => setError(cause instanceof Error ? cause.message : "读取失败")).finally(() => setBusy(false)); return () => uploadController.current?.abort(); }, [refresh]);
  async function run(operation: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (cause) { setNotice(""); setError(cause instanceof Error ? cause.message : "备份操作失败。"); }
    finally { lock.current = false; setBusy(false); }
  }
  async function importFile(file: File) {
    if (file.size > 512 * 1024 * 1024 || !file.size) throw new Error("备份必须非空且不超过 512 MiB。");
    const controller = new AbortController(); uploadController.current = controller;
    let id: string | undefined;
    try {
      const started = await settingsRequest<{ data: { id: string; chunkBytes: number } }>("/api/backups/import", { ...jsonRequest("POST", { bytes: file.size }), signal: controller.signal }); id = started.data.id;
      for (let offset = 0; offset < file.size; offset += started.data.chunkBytes) {
        setNotice(`正在导入 ${Math.round(offset / file.size * 100)}%…`);
        await settingsRequest(`/api/backups/import/${id}?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, offset + started.data.chunkBytes), signal: controller.signal });
      }
      await settingsRequest(`/api/backups/import/${id}`, { method: "POST", signal: controller.signal });
      await refresh(); setNotice("备份已导入并校验，尚未覆盖当前数据。选择“恢复”后还需确认。");
    } catch (cause) {
      if (id) await settingsRequest(`/api/backups/import/${id}`, { method: "DELETE" }).catch(() => {});
      throw controller.signal.aborted ? new Error("导入已取消，当前业务数据未改变。") : cause;
    } finally { uploadController.current = null; }
  }
  function openConfirmation(backup: Backup, operation: "restore" | "delete") {
    void run(async () => { setSelected(operation === "delete" ? { ...backup, counts: {} } : (await settingsRequest<{ data: Detail }>(`/api/backups/${backup.id}`)).data); setAction(operation); setConfirmation(""); dialog.current?.showModal(); });
  }
  function confirm() {
    if (!selected) return; const id = selected.id; dialog.current?.close();
    void run(async () => {
      if (action === "restore") {
        const result = await settingsRequest<{ data: { safetyBackupId: string; cleanupFailed: boolean } }>(`/api/backups/${id}`, jsonRequest("POST", { confirm: true }));
        for (const key of Object.keys(localStorage)) if (key.startsWith(CHAT_PREFS_STORAGE_PREFIX) || key === LAST_ACTIVE_CHAT_STORAGE_KEY) localStorage.removeItem(key);
        setNotice(`恢复完成。原数据已保存为安全备份 ${result.data.safetyBackupId}。任务提醒已关闭，请按需重新启用。${result.data.cleanupFailed ? "部分过期备份未能清理，请检查存储目录权限。" : ""}`);
      } else { await settingsRequest(`/api/backups/${id}`, { method: "DELETE" }); setNotice("备份文件已永久删除。"); }
      setSelected(null); await refresh();
    });
  }
  return <main className="mx-auto max-w-4xl space-y-5 px-4 py-8">
    <header className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold">备份与恢复</h1><Link href="/chat" className="text-primary underline">返回聊天</Link></header>
    <p className="text-sm text-muted-foreground">备份当前账户的会话、知识、任务、媒体、模型设置和用量记录。不包含登录凭据、API 密钥或其他账户。文件未加密，请存放在可信位置。</p>
    <div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={() => void run(async () => { setNotice("正在创建完整备份…"); await settingsRequest("/api/backups", { method: "POST" }); await refresh(); setNotice("备份创建完成，可下载到其他位置保存。"); })}>创建备份</Button><Button variant="outline" disabled={busy} onClick={() => void run(refresh)}>刷新备份</Button><label className="text-sm">导入备份文件<input className="mt-1 block max-w-full text-sm" aria-label="导入备份文件" disabled={busy} type="file" accept=".paib" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void run(() => importFile(file)); }} /></label>{busy && uploadController.current && <Button variant="outline" onClick={() => uploadController.current?.abort()}>取消导入</Button>}</div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}{notice && <p role="status" className="break-words text-sm">{notice}</p>}{busy && <p className="text-sm" role="status">正在处理，请勿重复操作…</p>}
    <section className="space-y-3 rounded-xl border p-4" aria-label="备份保留策略"><h2 className="font-semibold">自动清理过期备份</h2><p className="text-sm text-muted-foreground">服务运行时启动检查并每小时清理；创建备份后也会清理。始终保留最新的一份完整备份。关闭应用时不执行清理。</p><div className="flex flex-wrap items-end gap-3"><label className="text-sm">保留天数<Input aria-label="保留天数" className="w-28" type="number" min={1} max={365} value={days} onChange={event => setDays(Number(event.target.value))} disabled={busy} /></label><label className="text-sm">最多份数<Input aria-label="最多份数" className="w-28" type="number" min={2} max={20} value={count} onChange={event => setCount(Number(event.target.value))} disabled={busy} /></label><Button disabled={busy} variant="outline" onClick={() => void run(async () => { const settings = await settingsRequest<{ data: ModelPreferences }>("/api/models"); await settingsRequest("/api/models", jsonRequest("PUT", { ...settings.data, backupRetentionDays: days, backupMaxCount: count })); setNotice("保留策略已保存，将在下次清理时生效。"); })}>保存保留策略</Button></div></section>
    <section aria-label="备份列表" className="space-y-3">{backups.map(backup => <article key={backup.id} aria-label={`备份 ${backup.id}`} className="space-y-3 rounded-xl border p-4"><p className="font-medium">{new Date(backup.createdAt).toLocaleString()} · {formatBytes(backup.bytes)}</p><p className="break-all text-xs text-muted-foreground">{backup.id}</p><div className="flex flex-wrap gap-2"><Button disabled={busy} variant="outline" onClick={() => void run(async () => { await settingsRequest(`/api/backups/${backup.id}`); downloadBackup(backup.id); })}>下载备份</Button><Button disabled={busy} variant="outline" onClick={() => openConfirmation(backup, "restore")}>恢复</Button><Button disabled={busy} variant="destructive" onClick={() => openConfirmation(backup, "delete")}>删除备份</Button></div></article>)}{!backups.length && <p className="text-sm text-muted-foreground">尚无完整备份。备份总大小上限 512 MiB，超限请使用停机后的数据库与媒体目录备份。</p>}</section>
    <dialog ref={dialog} aria-labelledby="backup-confirm-title" className="w-[min(34rem,92vw)] space-y-4 rounded-xl border bg-background p-6 text-foreground backdrop:bg-black/50"><h2 id="backup-confirm-title" className="text-lg font-semibold">{action === "restore" ? "确认覆盖当前账户数据？" : "永久删除备份？"}</h2><p className="break-all text-xs">{selected?.id}</p>{action === "restore" ? <><p className="text-sm">先自动保存当前数据，再恢复所选备份。模型设置会恢复，任务提醒先关闭，旧审批不会重放。恢复完成后请刷新其他打开的窗口。此操作不合并数据。</p><p className="text-sm">会话 {selected?.counts.chats} · 消息 {selected?.counts.messages} · 媒体 {selected?.counts.assets} · 文档 {selected?.counts.documents} · 任务 {selected?.counts.tasks}</p><label className="block text-sm">输入“恢复”确认<Input aria-label="恢复确认文字" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label></> : <p>此备份文件无法找回，不影响当前业务数据。</p>}<div className="flex justify-end gap-2"><Button autoFocus variant="outline" onClick={() => dialog.current?.close()}>取消操作</Button><Button variant="destructive" disabled={busy || action === "restore" && confirmation !== "恢复"} onClick={confirm}>{action === "restore" ? "确认恢复" : "确认删除备份"}</Button></div></dialog>
  </main>;
}
