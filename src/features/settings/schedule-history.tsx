"use client";
import { useDesktopRuntime } from "@/lib/use-desktop-runtime";
import { useLocale } from "@/lib/locale/client";

import { t, formatDateTime, localizeMessage } from "@/lib/locale";

import Link from "next/link";
import { SettingsLink } from "@/features/settings/settings-context";
import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsHelp, SettingsSection } from "@/features/settings/settings-section";
import { Status } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { executionGuidance } from "@/lib/execution-messages";
import type { ScheduledRunView } from "@/lib/scheduler/history";

const statusLabel = (status: string) => ({ running: t("ui.chat.run-records.running"), succeeded: t("chat.tasks.statusDone"), failed: t("models.statusFailed"), interrupted: t("ui.models.usage-history.processInterrupted") })[status] ?? t("ui.settings.schedule-history.unknownStatus");

export function ScheduleHistory({ refreshKey, onExecuted }: { refreshKey: number; onExecuted: () => Promise<void> }) {
  useLocale();
  const [runs, setRuns] = useState<ScheduledRunView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // Plans run on their own only in the desktop app. Starting from that, the
  // notice about it is in place from the first paint instead of appearing
  // when the history answers and pushing everything below it down.
  const [automatic, setAutomatic] = useState(useDesktopRuntime());
  const latestRequest = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++latestRequest.current;
    try {
      const response = await fetch("/api/schedules/runs", { cache: "no-store", signal });
      if (!response.ok) throw new Error(response.status === 503 ? t("ui.settings.schedule-history.workspaceTemporarilyUnavailableNoNewScheduled") : t("ui.settings.schedule-history.couldNotLoadExecutionHistory"));
      const payload = await response.json();
      if (signal?.aborted || request !== latestRequest.current) return;
      setRuns(payload.data);
      setAutomatic(payload.automaticExecution);
      setError(null);
    } catch (failure) {
      if (!signal?.aborted && request === latestRequest.current) setError(failure instanceof Error ? failure.message : t("ui.settings.schedule-history.couldNotLoadExecutionHistory"));
    } finally { if (!signal?.aborted && request === latestRequest.current) setLoading(false); }
  }, []);
  const running = runs.some(run => run.status === "running");
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const timer = running || busy ? setInterval(() => void load(controller.signal), 5000) : null;
    return () => { controller.abort(); if (timer) clearInterval(timer); };
  }, [load, refreshKey, running, busy]);

  async function retry(run: ScheduledRunView) {
    if (busy || !run.jobId) return;
    setBusy(true);
    setRetryError(null);
    try {
      const response = await fetch(`/api/schedules/${encodeURIComponent(run.jobId)}/retry`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: run.id }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? t("ui.settings.schedule-history.couldNotStartANewExecution"));
    } catch (failure) { setRetryError(failure instanceof Error ? failure.message : t("ui.settings.schedule-history.couldNotStartANewExecution")); }
    finally {
      await Promise.all([load(), onExecuted()]);
      setBusy(false);
    }
  }

  return (
    <SettingsSection role="region" aria-label={t("ui.settings.schedule-history.scheduledExecutionHistory")} title={t("ui.settings.schedule-history.recentExecutions")} description={t("ui.settings.schedule-history.viewScheduledRunResultsOrRetry")} action={
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void load()} size="sm" type="button" variant="ghost">{t("ui.settings.schedule-history.refreshRecords")}</Button>
          <a className="text-xs underline underline-offset-4 self-center" href="/api/diagnostics" download>{t("ui.chat.run-records.exportRedactedDiagnostics")}</a>
        </div>
      }><div className="flex flex-col gap-3">
      {!automatic ? <p className="text-xs text-warning">{t("ui.settings.schedule-history.automaticSchedulingIsDisabledInThe")}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{localizeMessage(error)}</p> : null}
      {retryError ? <p role="alert" className="text-xs text-destructive">{retryError}</p> : null}
      {loading ? <p className="text-xs text-muted-foreground">{t("ui.settings.schedule-history.loadingExecutionHistory")}</p> : runs.length === 0 ? <p className="text-xs text-muted-foreground">{t("ui.settings.schedule-history.noExecutionRecordsYet")}</p> : (
        <ul className="settings-list">
          {runs.map(run => (
            <li key={run.id} className="settings-history-row text-xs">
              <p className="flex flex-wrap justify-between gap-2"><span>{["backupReminder", "scheduledBackup", "dailyBrief", "weeklySummary"].includes(run.kind) ? t(`settings.schedules.kind.${run.kind}` as never) : t("ui.settings.schedule-history.unsupportedTaskType")}</span><span className="flex items-center gap-2"><Status tone={run.status === "failed" || run.status === "interrupted" ? "danger" : run.status === "succeeded" ? "success" : "neutral"}>{statusLabel(run.status)}</Status>{run.trigger === "manual" ? t("ui.settings.schedule-history.manualRetry") : t("ui.settings.schedule-history.scheduledRun")}</span></p>
              <p className="text-muted-foreground">{t("ui.settings.schedule-history.started")}{formatDateTime(new Date(run.startedAt))} {t("ui.settings.schedule-history.finished")}{run.finishedAt ? formatDateTime(new Date(run.finishedAt)) : t("ui.settings.schedule-history.notFinished")}</p>
              {run.errorCode ? <p>{run.status === "succeeded" ? t("ui.settings.schedule-history.localResultSavedModelCommentaryIncomplete") : ""}{run.errorCode} · {executionGuidance(run.errorCode)}</p> : null}
              {!run.jobId ? <p className="text-muted-foreground">{t("ui.settings.schedule-history.originalScheduleDeletedExecutionEvidenceIs")}</p> : null}
              <div className="flex flex-wrap items-center gap-3">
                {run.chatId ? <Link className="underline" href={`/chat?conversationId=${encodeURIComponent(run.chatId)}`}>{t("ui.settings.schedule-history.openGeneratedConversation")}</Link> : null}
                {run.backupId ? <SettingsLink className="underline" section="backups">{t("ui.settings.schedule-history.viewBackup")}</SettingsLink> : null}
                {run.canRetry ? <Button disabled={busy} onClick={() => void retry(run)} size="sm" type="button" variant="ghost">{busy ? t("ui.settings.schedule-history.running") : t("ui.settings.schedule-history.runOnceAgain")}</Button> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <SettingsHelp title={t("ui.settings.schedule-history.recordRetentionRetryRules")}>
        <p>{t("ui.settings.schedule-history.executionRecordsAreRetainedFor90")}</p>
        <p>{t("ui.settings.schedule-history.diagnosticsIncludeOnlyTimesStatusAnd")}</p>
        <p>{t("ui.settings.schedule-history.rerunningCreatesANewRecordAnd")}</p>
      </SettingsHelp>
      </div></SettingsSection>
  );
}
