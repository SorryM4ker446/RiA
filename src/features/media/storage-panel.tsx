"use client";
import { getApiErrorMessage } from "@/lib/api-error-message";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RefreshButton } from "@/components/ui/refresh-button";
import { t } from "@/lib/locale";

type StorageStats = { assetCount: number; totalBytes: number; referencedCount: number; unreferencedCount: number; reclaimableCount: number; looseFileCount: number; graceHours: number };

export function StoragePanel({ revision = 0, onChanged }: { revision?: number; onChanged?: () => void }) {
  const [stats, setStats] = useState<StorageStats | null>(null);
  /* A read is always in flight on mount, so `busy` starts true. Starting it
     false painted the "nothing here yet" line for one frame and then swapped it
     for the loading line, which read as the numbers flickering into view. */
  const [busy, setBusy] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
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
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/media/cleanup", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(getApiErrorMessage(payload, t("mediaStorage.cleanupFailed")));
      setMessage(`${t("mediaStorage.cleaned")} ${payload.data.removedCount} ${t("mediaStorage.freedFiles")} ${(payload.data.freedBytes / 1024 / 1024).toFixed(2)} ${t("mediaStorage.mib")}${payload.data.failedCount ? ` ${payload.data.failedCount} ${t("mediaStorage.failedSuffix")}` : ""}`);
      await refresh();
      onChanged?.();
    } catch (error) { setError(error instanceof Error ? error.message : t("mediaStorage.cleanupFailed")); }
    finally { setBusy(false); setConfirming(false); }
  }

  return <>

    <Card>
      <CardHeader><CardTitle>{t("mediaStorage.title")}</CardTitle><CardDescription>{t("mediaStorage.description")}</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
        {stats ? <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t("mediaStorage.diskUsage")}</dt><dd className="font-mono tabular-nums">{(stats.totalBytes / 1024 / 1024).toFixed(2)} MiB</dd>
          <dt className="text-muted-foreground">{t("mediaStorage.assetCount")}</dt><dd className="font-mono tabular-nums">{stats.assetCount}</dd>
          <dt className="text-muted-foreground">{t("mediaStorage.referenced")}</dt><dd className="font-mono tabular-nums">{stats.referencedCount}</dd>
          <dt className="text-muted-foreground">{t("mediaStorage.unreferenced")}</dt><dd className="font-mono tabular-nums">{stats.unreferencedCount}</dd>
          <dt className="text-muted-foreground">{t("mediaStorage.reclaimable")}</dt><dd className="font-mono tabular-nums">{stats.reclaimableCount}</dd>
        </dl> : <p className="text-sm text-muted-foreground">{busy ? t("mediaStorage.loading") : t("mediaStorage.empty")}</p>}
        <p className="text-sm leading-6 text-muted-foreground">{t("mediaStorage.retentionNote")}</p>
        <div className="flex flex-wrap gap-2">
          <RefreshButton disabled={busy} onClick={() => void refresh()} refreshing={busy} label={t("mediaStorage.refresh")} />
          {confirming ? <><Button disabled={busy} onClick={() => void cleanup()} variant="destructive">{t("mediaStorage.confirmCleanup")}</Button><Button disabled={busy} onClick={() => setConfirming(false)} variant="ghost">{t("mediaStorage.cancel")}</Button></>
            : <Button disabled={busy || !stats?.reclaimableCount} onClick={() => setConfirming(true)} variant="secondary">{t("mediaStorage.cleanup")}</Button>}
        </div>
      </CardContent>
    </Card>
  </>;
}
