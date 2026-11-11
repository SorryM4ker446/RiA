"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Reveal } from "@/components/ui/reveal";
import { useToast } from "@/components/ui/toast";
import { jsonRequest, settingsRequest } from "@/features/settings/api-client";
import { SettingsLink } from "@/features/settings/settings-context";
import { SettingsHelp, SettingsSection } from "@/features/settings/settings-section";
import { localizeMessage, t, tf } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { callLimitRanges, type ModelPreferences } from "@/lib/models/preferences-schema";
import { useDesktopRuntime } from "@/lib/use-desktop-runtime";

/*
 * The rules every task follows, as opposed to any one task.
 *
 * The tasks themselves are made and changed on the Tasks page. What lives here
 * is what holds for all of them: how much work may start on its own in a day,
 * what it may cost, and which of their outcomes interrupt the user.
 */

const BACKGROUND_FIELDS = ["backgroundDailyCalls", "backgroundMaxEstimatedUsd", "backgroundDailyEstimatedUsd"] as const;
type BackgroundField = (typeof BACKGROUND_FIELDS)[number];
type BackgroundLimits = Pick<ModelPreferences["callLimits"], BackgroundField>;

const fieldLabel = (field: BackgroundField) => ({
  backgroundDailyCalls: t("tasks.rules.dailyRuns"),
  backgroundMaxEstimatedUsd: t("tasks.rules.callUsd"),
  backgroundDailyEstimatedUsd: t("tasks.rules.dailyUsd"),
})[field];

function invalidFields(limits: BackgroundLimits): Set<BackgroundField> {
  const problems = new Set<BackgroundField>();
  for (const field of BACKGROUND_FIELDS) {
    const range = callLimitRanges[field], value = limits[field];
    if (value === null && !range.integer) continue;
    if (value === null || !Number.isFinite(value) || value < range.min || value > range.max || (range.integer && !Number.isInteger(value))) problems.add(field);
  }
  return problems;
}

const pick = (limits: ModelPreferences["callLimits"]): BackgroundLimits => ({
  backgroundDailyCalls: limits.backgroundDailyCalls,
  backgroundMaxEstimatedUsd: limits.backgroundMaxEstimatedUsd,
  backgroundDailyEstimatedUsd: limits.backgroundDailyEstimatedUsd,
});

/** How much work may start on its own: runs a day, and what calls may cost. */
export function BackgroundTaskRules() {
  useLocale();
  const toast = useToast();
  const [saved, setSaved] = useState<BackgroundLimits | null>(null);
  const [draft, setDraft] = useState<BackgroundLimits | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    settingsRequest<{ data: ModelPreferences }>("/api/models", { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) { setSaved(pick(data.callLimits)); setDraft(pick(data.callLimits)); } })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("tasks.rules.loadFailed")); });
    return () => controller.abort();
  }, []);

  const problems = draft ? invalidFields(draft) : new Set<BackgroundField>();
  const dirty = Boolean(draft && saved && BACKGROUND_FIELDS.some(field => draft[field] !== saved[field]));

  async function save() {
    if (!draft || problems.size) return;
    setBusy(true);
    setError(null);
    try {
      // Read the latest first and change only these three, so a model choice or
      // another limit saved meanwhile on the Models section is kept.
      const { data: latest } = await settingsRequest<{ data: ModelPreferences }>("/api/models");
      const { data } = await settingsRequest<{ data: ModelPreferences }>("/api/models", jsonRequest("PUT", { ...latest, callLimits: { ...latest.callLimits, ...draft } }));
      setSaved(pick(data.callLimits));
      setDraft(pick(data.callLimits));
      toast(t("tasks.rules.saved"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("tasks.rules.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsSection role="region" aria-label={t("tasks.rules.title")} title={t("tasks.rules.title")} description={t("tasks.rules.description")}>
      <div className="flex flex-col gap-4">
        <Reveal>{error ? <p role="alert" className="text-sm text-destructive">{localizeMessage(error)}</p> : null}</Reveal>
        {/* The rows are there while the values load, so nothing below moves when they arrive. */}
        {(
          <div className="setting-rows" aria-busy={!draft || undefined}>
            {BACKGROUND_FIELDS.map(field => {
              const range = callLimitRanges[field], value = draft ? draft[field] : null, invalid = problems.has(field);
              const bounds = { min: range.min.toLocaleString("en-US"), max: range.max.toLocaleString("en-US") };
              return (
                <Field key={field} orientation="horizontal" className="setting-row" data-invalid={invalid || undefined}>
                  <span className="setting-row-label">
                    <FieldLabel htmlFor={`task-rule-${field}`}>{fieldLabel(field)}</FieldLabel>
                    {invalid
                      ? <FieldError id={`task-rule-${field}-hint`} className="text-xs">{tf(range.integer ? "ui.models.limitInvalidInteger" : "ui.models.limitInvalidUsd", bounds)}</FieldError>
                      : <FieldDescription id={`task-rule-${field}-hint`} className="setting-row-hint">{tf(range.integer ? "ui.models.limitRangeInteger" : "ui.models.limitRangeUsd", bounds)}</FieldDescription>}
                  </span>
                  <Input id={`task-rule-${field}`} className="w-44" aria-describedby={`task-rule-${field}-hint`} aria-invalid={invalid || undefined}
                    type="number" inputMode={range.integer ? "numeric" : "decimal"} min={range.min} max={range.max} step={range.integer ? 1 : "any"}
                    value={value === null ? "" : Number.isNaN(value) ? "" : value} disabled={busy || !draft}
                    onChange={event => { if (draft) setDraft({ ...draft, [field]: event.target.value === "" ? (range.integer ? Number.NaN : null) : Number(event.target.value) }); }} />
                </Field>
              );
            })}
          </div>
        )}
        <SettingsHelp title={t("tasks.rules.helpTitle")}>
          <p>{t("tasks.rules.helpRuns")}</p>
          <p>{t("tasks.rules.helpMoney")}</p>
          <p>{t("tasks.rules.helpDay")} <SettingsLink className="underline underline-offset-4" section="models">{t("tasks.rules.helpDayLink")}</SettingsLink></p>
          <p>{t("tasks.rules.helpRunning")} <SettingsLink className="underline underline-offset-4" section="application">{t("tasks.rules.helpRunningLink")}</SettingsLink></p>
        </SettingsHelp>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/55 pt-4">
          <p className="text-xs text-muted-foreground">{problems.size ? t("tasks.rules.fixBeforeSaving") : t("tasks.rules.note")}</p>
          <Button size="sm" disabled={!dirty || busy || problems.size > 0} onClick={() => void save()}>
            {busy ? <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" /> : null}
            {t("chat.common.save")}
          </Button>
        </footer>
      </div>
    </SettingsSection>
  );
}

const EVENTS = ["task-finished", "task-failed", "task-needs-approval", "task-skipped", "task-missed"] as const;

/** Which task outcomes also appear as a system notification. The notice is kept in the app either way. */
export function TaskNotificationSettings() {
  useLocale();
  const desktop = useDesktopRuntime();
  const [choices, setChoices] = useState<Record<DesktopTaskNoticeEvent, boolean> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    void window.riaDesktop?.getSettings()
      .then(view => { if (!cancelled) setChoices(view.taskNotifications); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : t("tasks.notify.failed")); });
    return () => { cancelled = true; };
  }, [desktop]);

  // System notifications exist only in the desktop app.
  if (!desktop) return null;

  async function toggle(event: DesktopTaskNoticeEvent, on: boolean) {
    if (!choices) return;
    const previous = choices;
    // The switch shows at once; a refused save puts it back.
    setChoices({ ...choices, [event]: on });
    setError(null);
    try {
      const result = await window.riaDesktop!.saveSettings({ taskNotifications: { [event]: on } });
      setChoices(result.settings.taskNotifications);
    } catch (cause) {
      setChoices(previous);
      setError(cause instanceof Error ? cause.message : t("tasks.notify.failed"));
    }
  }

  return (
    <SettingsSection role="region" aria-label={t("tasks.notify.title")} title={t("tasks.notify.title")} description={t("tasks.notify.description")}>
      <div className="flex flex-col gap-3">
        <Reveal>{error ? <p role="alert" className="text-sm text-destructive">{localizeMessage(error)}</p> : null}</Reveal>
        <div className="flex flex-col gap-2.5" aria-busy={!choices || undefined}>
          {EVENTS.map(event => (
            <label key={event} className="flex items-center gap-2.5 text-sm">
              <Checkbox checked={choices?.[event] ?? false} disabled={!choices} onCheckedChange={value => void toggle(event, value === true)} aria-label={t(`tasks.notify.${event}`)} />
              {t(`tasks.notify.${event}`)}
            </label>
          ))}
        </div>
      </div>
    </SettingsSection>
  );
}
