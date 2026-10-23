"use client";
import { useLocale } from "@/lib/locale/client";

import { getApiErrorMessage } from "@/lib/api-error-message";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Reveal } from "@/components/ui/reveal";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { t, localizeMessage } from "@/lib/locale";

type StorageStats = { assetCount: number; totalBytes: number; referencedCount: number; unreferencedCount: number; reclaimableCount: number; looseFileCount: number; graceHours: number };

export function StoragePanel({ revision = 0, onChanged, embedded = false }: { revision?: number; onChanged?: () => void; embedded?: boolean }) {
  useLocale();
  const confirm = useConfirm();
  const toast = useToast();
  const [stats, setStats] = useState<StorageStats | null>(null);
  /* A read is always in flight on mount, so `busy` starts true. Starting it
     false painted the "nothing here yet" line for one frame and then swapped it
     for the loading line, which read as the numbers flickering into view. */
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/media", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(getApiErrorMessage(payload, t("mediaStorage.loadError")));
      setStats(payload.data);
    } catch (error) { setError(error instanceof Error ? error.message : t("mediaStorage.readFailed")); }
    finally { setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh, revision]);

  async function cleanup() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/media/cleanup", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(getApiErrorMessage(payload, t("mediaStorage.cleanupFailed")));
      toast(`${t("mediaStorage.cleaned")} ${payload.data.removedCount} ${t("mediaStorage.freedFiles")} ${(payload.data.freedBytes / 1024 / 1024).toFixed(2)} ${t("mediaStorage.mib")}${payload.data.failedCount ? ` ${payload.data.failedCount} ${t("mediaStorage.failedSuffix")}` : ""}`);
      await refresh();
      onChanged?.();
    } catch (error) { setError(error instanceof Error ? error.message : t("mediaStorage.cleanupFailed")); }
    finally { setBusy(false); }
  }
  async function askCleanup() {
    if (await confirm({ title: t("mediaStorage.cleanup"), description: t("mediaStorage.retentionNote"), action: t("mediaStorage.confirmCleanup"), destructive: true })) await cleanup();
  }

  const content = <div className="flex flex-col gap-4">
    <Reveal className="-mt-4">{error ? <p role="alert" className="mt-4 rounded-lg bg-destructive/5 p-3 text-sm text-destructive shadow-hairline">{localizeMessage(error)}</p> : null}</Reveal>
    {stats ? <dl className="stat-grid">
      <div><dt>{t("mediaStorage.diskUsage")}</dt><dd>{(stats.totalBytes / 1024 / 1024).toFixed(2)} <span className="text-xs font-normal text-muted-foreground">MiB</span></dd></div>
      <div><dt>{t("mediaStorage.assetCount")}</dt><dd>{stats.assetCount}</dd></div>
      <div><dt>{t("mediaStorage.referenced")}</dt><dd>{stats.referencedCount}</dd></div>
      <div><dt>{t("mediaStorage.unreferenced")}</dt><dd>{stats.unreferencedCount}</dd></div>
      <div><dt>{t("mediaStorage.reclaimable")}</dt><dd>{stats.reclaimableCount}</dd></div>
    </dl> : <p className="text-sm text-muted-foreground">{busy ? t("mediaStorage.loading") : t("mediaStorage.empty")}</p>}
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-2xl text-xs leading-5 text-muted-foreground">{t("mediaStorage.retentionNote")}</p>
      <div className="flex items-center gap-1"><RefreshButton iconOnly disabled={busy} onClick={() => void refresh()} refreshing={busy && Boolean(stats)} label={t("mediaStorage.refresh")} /><Button size="sm" variant="ghost" disabled={busy || !stats?.reclaimableCount} onClick={() => void askCleanup()}>{t("mediaStorage.cleanup")}</Button></div></div>
  </div>;
  if (embedded) return content;
  return <section className="surface" aria-label={t("mediaStorage.title")}><div className="flex flex-col gap-1 p-5 pb-0"><h2 className="text-base font-semibold tracking-title">{t("mediaStorage.title")}</h2><p className="text-sm text-muted-foreground">{t("mediaStorage.description")}</p></div><div className="p-5">{content}</div></section>;
}
