"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, formatDateTime, localizeMessage } from "@/lib/locale";

import { SelectField, SelectOption } from "@/components/ui/select";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Status } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { SettingsHelp, SettingsSection } from "@/features/settings/settings-section";
import { Input } from "@/components/ui/input";
import { ScheduleHistory } from "@/features/settings/schedule-history";
import { executionGuidance } from "@/lib/execution-messages";
import { WorkspaceReviewPreview } from "@/features/settings/workspace-review";
import { animateRemoval, removalKey } from "@/lib/ui/removal";

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

/** Opening or closing the editor never creates a schedule. Creation submits
 * the user's enablement and model choices; saved jobs remain authoritative. */
export function ScheduleSettings() {
  useLocale();
  const [creating, setCreating] = useState(false);
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

  async function send(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown, removing?: string) {
    setError(null);
    try {
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      if (!response.ok) throw new Error(await readError(response));
      if (removing) await animateRemoval(removing, load);
      else await load();
      return true;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t("settings.schedules.failed"));
      return false;
    }
  }

  async function create(event: { preventDefault: () => void }) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    const created = await send("POST", "/api/schedules", {
      kind,
      enabled,
      useModel: (kind === "dailyBrief" || kind === "weeklySummary") && useModel,
      localTime,
      timeZone,
      interval,
      dayOfWeek: interval === "weekly" ? dayOfWeek : null
    });
    setSaving(false);
    if (created) setCreating(false);
  }

  const failure = error ? <Alert variant="destructive"><AlertTitle>{t("settings.schedules.failedTitle")}</AlertTitle><AlertDescription>{localizeMessage(error)}</AlertDescription></Alert> : null;
  const modelKind = kind === "dailyBrief" || kind === "weeklySummary";
  return <Sheet open={creating} onOpenChange={open => { if (!saving) setCreating(open); }}>
    <SettingsSection title={t("settings.schedules.title")} description={t("ui.settings.schedules.scheduleWorkspaceReviewsOrManageBackups")} action={
      <SheetTrigger asChild><Button size="sm" disabled={loading || saving}><Plus data-icon="inline-start" />{t("ui.settings.schedules.addSchedule")}</Button></SheetTrigger>
    }>
      <div className="flex flex-col gap-3">
        {!creating ? failure : null}
        {loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />{t("settings.schedules.loading")}</p>
          : jobs.length === 0 ? <Empty className="items-start px-0 py-3 text-left"><EmptyDescription>{t("settings.schedules.empty")} {t("ui.settings.schedules.selectAddScheduleToGetStarted")}</EmptyDescription></Empty>
          : <ul className="settings-list" aria-label={t("ui.settings.schedules.addedSchedules")}>{jobs.map(job => <li key={job.id} {...removalKey(job.id)}>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{t(`settings.schedules.kind.${job.kind}` as never)}<Status tone={job.enabled ? "success" : "neutral"} className="font-normal">{job.enabled ? t("settings.schedules.on") : t("settings.schedules.off")}</Status></p>
              <p className="text-xs text-muted-foreground">{job.interval === "weekly" ? t(`settings.schedules.weekday.${job.dayOfWeek ?? 1}` as never) : t("settings.schedules.daily")} · {job.localTime} · <span className="break-all">{job.timeZone}</span></p>
              <p className="text-xs text-muted-foreground">{t("settings.schedules.next")} {formatDateTime(new Date(job.nextRunAt))}</p>
              {job.kind === "dailyBrief" || job.kind === "weeklySummary" ? <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={job.useModel} onChange={() => void send("PATCH", `/api/schedules/${encodeURIComponent(job.id)}`, { useModel: !job.useModel })} />{t("ui.settings.schedules.allowModelCommentaryAtMostOne")}</label> : null}
              {job.lastStatus ? <p className="text-xs text-muted-foreground">{tf("settings.schedules.lastRun", { status: job.lastStatus })}{job.lastError ? ` — ${executionGuidance(job.lastError)}` : ""}</p> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => void send("PATCH", `/api/schedules/${encodeURIComponent(job.id)}`, { enabled: !job.enabled })}>{job.enabled ? t("settings.schedules.pause") : t("settings.schedules.resume")}</Button>
              <Button aria-label={t("settings.schedules.delete")} size="icon-sm" variant="ghost" onClick={() => void send("DELETE", `/api/schedules/${encodeURIComponent(job.id)}`, undefined, job.id)}><Trash2 aria-hidden="true" /></Button>
            </div>
          </li>)}</ul>}
        <SettingsHelp title={t("ui.settings.schedules.executionRulesModelUsage")}>
          <p>{t("settings.schedules.note")}</p>
          <p>{t("settings.schedules.description")}</p><p>{t("settings.schedules.briefNote")}</p>
        </SettingsHelp>
      </div>
    </SettingsSection>
    <ScheduleHistory refreshKey={historyRefresh} onExecuted={load} />
    <WorkspaceReviewPreview />
      <SheetContent side="right" className="settings-create-sheet flex flex-col gap-5 overflow-y-auto p-6">
        <header className="flex flex-col gap-2 pr-6"><SheetTitle>{t("ui.settings.schedules.addSchedule")}</SheetTitle><SheetDescription>{t("ui.settings.schedules.chooseATimeAndTimeZone")}</SheetDescription></header>
        {failure}
        <form className="flex flex-1 flex-col gap-6" onSubmit={create}>
          <FieldGroup className="gap-5">
            <Field><FieldLabel htmlFor="schedule-kind">{t("settings.schedules.kindLabel")}</FieldLabel><SelectField id="schedule-kind" aria-label={t("settings.schedules.kindLabel")} value={kind} onValueChange={value => setKind(value as (typeof KINDS)[number])}>{KINDS.map(option => <SelectOption key={option} value={option}>{t(`settings.schedules.kind.${option}` as never)}</SelectOption>)}</SelectField></Field>
            <Field><FieldLabel htmlFor="schedule-time">{t("settings.schedules.timeLabel")}</FieldLabel><Input id="schedule-time" aria-label={t("settings.schedules.timeLabel")} type="time" value={localTime} onChange={event => setLocalTime(event.target.value)} required /></Field>
            <Field><FieldLabel htmlFor="schedule-interval">{t("settings.schedules.intervalLabel")}</FieldLabel><SelectField id="schedule-interval" aria-label={t("settings.schedules.intervalLabel")} value={interval} onValueChange={value => setInterval(value as "daily" | "weekly")}><SelectOption value="daily">{t("settings.schedules.daily")}</SelectOption><SelectOption value="weekly">{t("settings.schedules.weekly")}</SelectOption></SelectField></Field>
            {interval === "weekly" ? <Field><FieldLabel htmlFor="schedule-day">{t("settings.schedules.weekdayLabel")}</FieldLabel><SelectField id="schedule-day" aria-label={t("settings.schedules.weekdayLabel")} value={dayOfWeek} onValueChange={value => setDayOfWeek(Number(value))}>{WEEKDAYS.map(day => <SelectOption key={day} value={day}>{t(`settings.schedules.weekday.${day}` as never)}</SelectOption>)}</SelectField></Field> : null}
            <Field><FieldLabel htmlFor="schedule-zone">{t("settings.schedules.zoneLabel")}</FieldLabel><Input id="schedule-zone" aria-label={t("settings.schedules.zoneLabel")} value={timeZone} onChange={event => setTimeZone(event.target.value)} placeholder="Asia/Shanghai" required /></Field>
            <Field orientation="horizontal"><input id="schedule-enabled" type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><FieldLabel htmlFor="schedule-enabled">{t("settings.schedules.createEnabled")}</FieldLabel></Field>
            {modelKind ? <Field orientation="horizontal"><input id="schedule-model" type="checkbox" checked={useModel} onChange={event => setUseModel(event.target.checked)} /><FieldLabel htmlFor="schedule-model">{t("ui.settings.schedules.allowModelCommentaryMayIncurCharges")}</FieldLabel></Field> : null}
          </FieldGroup>
          <div className="mt-auto flex justify-end gap-2"><Button variant="ghost" type="button" disabled={saving} onClick={() => setCreating(false)}>{t("knowledge.cancelEdit")}</Button><Button type="submit" disabled={saving}>{saving ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}{t("settings.schedules.add")}</Button></div>
        </form>
      </SheetContent>
  </Sheet>;
}
