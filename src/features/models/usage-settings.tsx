"use client";
import { useLocale } from "@/lib/locale/client";
import { useRefreshOnReturn } from "@/lib/use-refresh-on-return";
import { Button } from "@/components/ui/button";

import { t, localizeMessage } from "@/lib/locale";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { Reveal } from "@/components/ui/reveal";
import { SelectField, SelectOption } from "@/components/ui/select";
import { UsageHistory, sourceNames, type UsageRow } from "@/features/models/usage-history";
import { settingsRequest } from "@/features/settings/api-client";
import type { ModelPreferences } from "@/lib/models/preferences-schema";

type Usage = { controls?: ModelPreferences["callLimits"] & { day: string; calls: number; estimatedUsd: number; active: number }; recent: UsageRow[]; totals: { requests: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; unknownCostRequests: number } };
const cost = (value: number | null) => value === null ? t("models.unknown") : `$${value.toFixed(6)}`;

/** Model calls, tokens and cost over the last 30 days, optionally for one source. */
export function UsageSettings() {
  useLocale();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageSource, setUsageSource] = useState("all");
  const [usageError, setUsageError] = useState("");
  // A reload is one more read of the same source. Counting reloads into the
  // read's dependencies means a reload and a change of source go through the
  // same request, so whichever is newer is the only one that can land.
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const changeUsageSource = (value: string) => { if (value !== usageSource) { setUsage(null); setUsageError(""); setUsageSource(value); } };
  useEffect(() => {
    const controller = new AbortController();
    settingsRequest<{ data: Usage }>(usageSource === "all" ? "/api/usage" : `/api/usage?source=${usageSource}`, { signal: controller.signal })
      .then(history => { if (!controller.signal.aborted) { setUsage(history.data); setUsageError(""); } })
      .catch(cause => { if (!controller.signal.aborted) setUsageError(cause instanceof Error ? cause.message : t("ui.models.couldNotLoadUsage")); })
      .finally(() => { if (!controller.signal.aborted) setRefreshing(false); });
    return () => controller.abort();
  }, [usageSource, revision]);

  // Read again when the window comes back into view, instead of a refresh button.
  useRefreshOnReturn(() => setRevision(value => value + 1));
  return <>
    <PageHeader level={2} title={t("ui.settingsOverlay.usage")} description={t("models.usageTitle")} actions={<><UsageHistory rows={usage?.recent} source={usageSource} onSourceChange={changeUsageSource} error={localizeMessage(usageError)} /></>} />
    <section id="model-usage" className="flex flex-col gap-5" aria-label={t("models.usageLabel")}>
      <label className="flex items-center gap-3 text-sm">{t("ui.models.callSource")}<SelectField aria-label={t("ui.models.callSource")} value={usageSource} onValueChange={changeUsageSource}><SelectOption value="all">{t("ui.models.allSources")}</SelectOption>{Object.entries(sourceNames()).map(([value, label]) => <SelectOption key={value} value={value}>{label}</SelectOption>)}</SelectField></label>
      <Reveal>{usageError ? <p role="alert" className="text-sm text-destructive"><span>{localizeMessage(usageError)}</span><Button size="sm" variant="ghost" className="ml-2 h-auto px-2 py-0.5 align-baseline" onClick={() => { setRefreshing(true); setRevision(value => value + 1); }}>{t("ui.chat.chat-toolbar.retry")}</Button></p> : null}</Reveal>
      <dl className="stat-grid">
        {[
          { label: t("models.usage.calls"), value: `${usage?.totals.requests ?? 0} ${t("models.usage.times")}` },
          { label: t("models.usage.input"), value: `${usage?.totals.inputTokens ?? t("models.unknown")} Token` },
          { label: t("models.usage.output"), value: `${usage?.totals.outputTokens ?? t("models.unknown")} Token` },
          { label: t("models.usage.knownCost"), value: cost(usage?.totals.costUsd ?? null) },
          { label: t("models.usage.unknownCost"), value: `${usage?.totals.unknownCostRequests ?? 0} ${t("models.usage.times")}` },
        ].map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd className="!text-base">{metric.value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{t("models.usageNote")}</p>
    </section>
  </>;
}
