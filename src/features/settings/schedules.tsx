"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Loader2, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { t, tf } from "@/lib/locale";
import { ScheduleHistory } from "@/features/settings/schedule-history";
import { executionGuidance } from "@/lib/execution-messages";
import { WorkspaceReviewPreview } from "@/features/settings/workspace-review";

type JobRow = {
  id: string;
  kind: string;
  enabled: boolean;
  useModel: boolean;
  localTime: string;
  timeZone: string;
  interval: string;
  dayOfWeek: number | null;
  nextRunAt: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
};

const KINDS = ["backupReminder", "scheduledBackup", "dailyBrief", "weeklySummary"] as const;
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    return typeof payload?.error?.message === "string" ? payload.error.message : t("settings.schedules.failed");
  } catch {
    return t("settings.schedules.failed");
  }
}

/**
 * Work the app does without being asked, and exactly as much of it as was asked
 * for.
 *
 * The switch is the point of this card. A schedule is created switched off, and
 * the state it will actually run in is shown next to it, because a reminder
 * that silently stops is worse than one that was never turned on. Nothing here
 * calls a model, so nothing here can cost money.
 */
export function ScheduleSettings() {
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [kind, setKind] = useState<(typeof KINDS)[number]>("backupReminder");
  const [localTime, setLocalTime] = useState("09:00");
  const [timeZone, setTimeZone] = useState(() => localTimeZone());
  const [interval, setInterval] = useState<"daily" | "weekly">("daily");
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [enabled, setEnabled] = useState(true);
  const [useModel, setUseModel] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyRefresh, setHistoryRefresh] = useState(0);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/schedules", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response));
      const payload = await response.json();
      setJobs(Array.isArray(payload.data) ? payload.data : []);
      setHistoryRefresh(current => current + 1);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("settings.schedules.failed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function send(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown) {
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      if (!response.ok) throw new Error(await readError(response));
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t("settings.schedules.failed"));
    }
  }

  async function create(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    await send("POST", "/api/schedules", {
      kind,
      enabled,
      useModel: (kind === "dailyBrief" || kind === "weeklySummary") && useModel,
      localTime,
      timeZone,
      interval,
      dayOfWeek: interval === "weekly" ? dayOfWeek : null
    });
    setSaving(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          {t("settings.schedules.title")}
        </CardTitle>
        <CardDescription>{t("settings.schedules.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{t("settings.schedules.failedTitle")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            {t("settings.schedules.loading")}
          </p>
        ) : jobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("settings.schedules.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {jobs.map((job) => (
              <li className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2" key={job.id}>
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {t(`settings.schedules.kind.${job.kind}` as never)}
                    <Badge variant={job.enabled ? "default" : "outline"}>
                      {job.enabled ? t("settings.schedules.on") : t("settings.schedules.off")}
                    </Badge>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.schedules.next")} {new Date(job.nextRunAt).toLocaleString()}
                  </p>
                  {job.kind === "dailyBrief" || job.kind === "weeklySummary" ? <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={job.useModel} onChange={() => void send("PATCH", `/api/schedules/${encodeURIComponent(job.id)}`, { useModel: !job.useModel })} />允许模型整理（每个期间最多一次请求）</label> : null}
                  {job.lastStatus ? (
                    <p className="text-[11px] text-muted-foreground">
                      {tf("settings.schedules.lastRun", { status: job.lastStatus })}
                      {job.lastError ? ` — ${executionGuidance(job.lastError)}` : ""}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    onClick={() => void send("PATCH", `/api/schedules/${encodeURIComponent(job.id)}`, { enabled: !job.enabled })}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {job.enabled ? t("settings.schedules.pause") : t("settings.schedules.resume")}
                  </Button>
                  <Button
                    aria-label={t("settings.schedules.delete")}
                    onClick={() => void send("DELETE", `/api/schedules/${encodeURIComponent(job.id)}`)}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form className="space-y-2 rounded-md border border-dashed border-border p-3" onSubmit={create}>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label={t("settings.schedules.kindLabel")}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              onChange={(event) => setKind(event.target.value as (typeof KINDS)[number])}
              value={kind}
            >
              {KINDS.map((option) => (
                <option key={option} value={option}>{t(`settings.schedules.kind.${option}` as never)}</option>
              ))}
            </select>
            <Input
              aria-label={t("settings.schedules.timeLabel")}
              className="w-28"
              onChange={(event) => setLocalTime(event.target.value)}
              type="time"
              value={localTime}
            />
            <select
              aria-label={t("settings.schedules.intervalLabel")}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              onChange={(event) => setInterval(event.target.value as "daily" | "weekly")}
              value={interval}
            >
              <option value="daily">{t("settings.schedules.daily")}</option>
              <option value="weekly">{t("settings.schedules.weekly")}</option>
            </select>
            {interval === "weekly" ? (
              <select
                aria-label={t("settings.schedules.weekdayLabel")}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                onChange={(event) => setDayOfWeek(Number(event.target.value))}
                value={dayOfWeek}
              >
                {WEEKDAYS.map((day) => (
                  <option key={day} value={day}>{t(`settings.schedules.weekday.${day}` as never)}</option>
                ))}
              </select>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Input
              aria-label={t("settings.schedules.zoneLabel")}
              className="flex-1"
              onChange={(event) => setTimeZone(event.target.value)}
              placeholder="Asia/Shanghai"
              value={timeZone}
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />
              {t("settings.schedules.createEnabled")}
            </label>
            <Button disabled={saving} type="submit">
              {saving ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : null}
              {t("settings.schedules.add")}
            </Button>
          </div>
          {kind === "dailyBrief" || kind === "weeklySummary" ? <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={useModel} onChange={event => setUseModel(event.target.checked)} />允许模型整理（可计费；本地事实回顾始终可用）</label> : null}
        </form>
        <p className="text-[11px] text-muted-foreground">{t("settings.schedules.note")}</p>
        <p className="text-[11px] text-muted-foreground">{t("settings.schedules.briefNote")}</p>
        <ScheduleHistory refreshKey={historyRefresh} onExecuted={load} />
        <WorkspaceReviewPreview />
      </CardContent>
    </Card>
  );
}
