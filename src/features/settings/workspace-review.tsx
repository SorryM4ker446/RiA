"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, formatDateTime, localizeMessage } from "@/lib/locale";

import { SelectField, SelectOption } from "@/components/ui/select";
import { useEffect, useState } from "react";
import Link from "next/link";
import { SettingsHelp, SettingsSection } from "@/features/settings/settings-section";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EVENT_KINDS, eventLabel, type ReviewFacts } from "@/lib/activity/types";
type Review = { timeZone: string; startAt: string; endAt: string; startDate: string; endDate: string; facts: ReviewFacts };
export function WorkspaceReviewPreview() {
  useLocale();
  const [period, setPeriod] = useState<"daily" | "weekly">("daily");
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [query, setQuery] = useState(() => ({ period: "daily" as "daily" | "weekly", timeZone }));
  const [result, setResult] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/activity/review?${new URLSearchParams(query)}`, { cache: "no-store", signal: controller.signal }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message ?? t("ui.settings.workspace-review.couldNotLoadReview"));
      if (!controller.signal.aborted) setResult(payload.data);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("ui.settings.workspace-review.couldNotLoadReview")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [query]);
  return <SettingsSection role="region" aria-label={t("ui.settings.workspace-review.workspaceFactualReview")} title={t("ui.settings.workspace-review.workspaceFactualReview")} description={t("ui.settings.workspace-review.viewRecordedTaskAndKnowledgeChanges")}><div className="flex flex-col gap-4">
    <form className="settings-review-form" onSubmit={event => { event.preventDefault(); setLoading(true); setError(null); setResult(null); setQuery({ period, timeZone }); }}>
      <FieldGroup className="settings-review-fields"><Field><FieldLabel htmlFor="review-period" className="sr-only">{t("ui.settings.workspace-review.reviewPeriod")}</FieldLabel><SelectField id="review-period" aria-label={t("ui.settings.workspace-review.reviewPeriod")} value={period} onValueChange={value => setPeriod(value as "daily" | "weekly")}><SelectOption value="daily">{t("ui.settings.workspace-review.previousFullDay")}</SelectOption><SelectOption value="weekly">{t("ui.settings.workspace-review.previousFullWeek")}</SelectOption></SelectField></Field>
      <Field><FieldLabel htmlFor="review-zone" className="sr-only">{t("ui.settings.workspace-review.reviewTimeZone")}</FieldLabel><Input id="review-zone" aria-label={t("ui.settings.workspace-review.reviewTimeZone")} value={timeZone} onChange={event => setTimeZone(event.target.value)} /></Field></FieldGroup>
      <Button disabled={loading} type="submit" variant="outline">{t("ui.settings.workspace-review.viewFactualReview")}</Button>
    </form>
    {error ? <p role="alert" className="text-sm text-destructive">{localizeMessage(error)}</p> : loading ? <p className="text-sm">{t("ui.settings.workspace-review.loadingEvents")}</p> : result ? <>
      <p className="text-sm">{result.startDate} {t("ui.settings.workspace-review.to")}{result.endDate}{t("ui.settings.workspace-review.endDateExcluded")}{result.timeZone}</p>
      <p className="text-xs text-muted-foreground">{result.facts.complete ? t("ui.settings.workspace-review.eventRecordsAreCompleteForThis") : tf("ui.settings.workspace-review.recordingStartedAtCoverageIsIncomplete", { v0: formatDateTime(new Date(result.facts.coverageFrom)) })}</p>
      <ul className="settings-facts">{EVENT_KINDS.map(kind => <li key={kind}>{eventLabel(kind)}：{result.facts.counts[kind]} {t("models.usage.times")}</li>)}</ul>
      <p className="text-xs text-muted-foreground">{t("ui.settings.workspace-review.completionsAndReopeningsAreCountedSeparately")}</p>
      {result.facts.sources.length ? <ol className="flex flex-col gap-2 text-sm">{result.facts.sources.map(source => <li key={source.id}><Link className="underline break-words" href={`/activity/events/${encodeURIComponent(source.id)}`}>{eventLabel(source.kind)} · {source.label}</Link></li>)}</ol> : <p className="text-sm">{t("ui.settings.workspace-review.noRecordedChangesDuringThisPeriod")}</p>}
      {result.facts.omitted ? <p className="text-xs">{t("ui.settings.workspace-review.onlyTheFirst100SourcesAre")}{result.facts.omitted} {t("ui.settings.workspace-review.areIncludedInTheStatistics")}</p> : null}
    </> : null}
    <SettingsHelp title={t("ui.settings.workspace-review.statisticsScopeRecordRetention")}><p>{t("ui.settings.workspace-review.dailyStatisticsCoverThePreviousFull")}</p><p>{t("ui.settings.workspace-review.eventsAreRetainedFor365Days")}</p></SettingsHelp>
  </div></SettingsSection>;
}
