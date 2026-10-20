"use client";
import { useLocale } from "@/lib/locale/client";

import { formatDateTime, t, tf, localizeMessage } from "@/lib/locale";

import { useRef, useState } from "react";
import { History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SelectField, SelectOption } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle, SheetDescription, SheetTrigger } from "@/components/ui/sheet";
export type UsageRow = { id: string; source: string; estimatedUsd: number | null; modelId: string; modelProvider: string; mode: string; status: string; durationMs: number; inputTokens: number | null; outputTokens: number | null; costUsd: number | null; costSource: string; fallback: boolean; errorCode: string | null; createdAt: string };
export const sourceNames = (): Record<string, string> => ({ chat: t("lib.models.catalogMode.chat"), summary: t("ui.models.usage-history.historySummary"), scheduled: t("ui.models.usage-history.scheduledReview"), tool: t("ui.models.usage-history.toolSynthesis"), embedding: t("lib.models.catalogMode.embedding"), media: t("ui.models.usage-history.mediaGeneration"), unattributed: t("ui.models.usage-history.sourceNotRecorded") });
const cost = (value: number | null) => value === null ? t("models.unknown") : `$${value.toFixed(6)}`;

function UsageList({ rows }: { rows: UsageRow[] }) {
  useLocale();
  const [limit, setLimit] = useState(8);
  const previousTop = useRef(0);
  const count = Math.min(limit, rows.length);
  return <div className="usage-history-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5" role="region" aria-label={t("ui.models.usage-history.callDetailsList")} tabIndex={0} onScroll={event => {
    const node = event.currentTarget;
    const movingDown = node.scrollTop > previousTop.current;
    previousTop.current = node.scrollTop;
    if (movingDown && node.scrollTop + node.clientHeight >= node.scrollHeight - 80) setLimit(current => Math.min(current + 8, rows.length));
  }}>
    <ul className="flex flex-col gap-2">{rows.slice(0, count).map(row => <li key={row.id} className="usage-history-row flex flex-col gap-3 rounded-xl bg-muted/40 p-4">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="break-all text-sm font-medium">{row.modelId}</p><p className="mt-1 break-words text-xs text-muted-foreground">{row.modelProvider} · {row.mode} · {sourceNames()[row.source] ?? t("ui.models.usage-history.sourceNotRecorded")}</p></div><span className="shrink-0 text-xs">{row.status === "pending" ? t("chat.tasks.statusInProgress") : row.status === "interrupted" ? t("ui.models.usage-history.processInterrupted") : row.status === "success" ? t("models.statusSuccess") : row.status === "aborted" ? t("models.statusAborted") : t("models.statusFailed")}{row.fallback ? t("models.statusFallback") : ""}</span></div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs tabular-nums"><div><dt className="text-muted-foreground">{t("models.thTokens")}</dt><dd className="mt-1">{row.inputTokens ?? t("models.unknown")} / {row.outputTokens ?? t("models.unknown")}</dd></div><div><dt className="text-muted-foreground">{t("ui.models.usage-history.cost")}{row.costSource === "provider" ? t("models.costSourceProvider") : row.costSource === "configured" ? t("models.costSourceConfigured") : t("models.costSourceUnknown")}</dt><dd className="mt-1">{cost(row.costUsd)}</dd></div></dl>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground"><span>{formatDateTime(row.createdAt)}</span><span>{row.durationMs} ms</span>{row.estimatedUsd != null && <span>{t("ui.models.usage-history.estimatedBeforeCall")}{cost(row.estimatedUsd)}</span>}{row.errorCode && <span className="break-all">{row.errorCode}</span>}</div>
    </li>)}</ul>
    <p className="py-4 text-center text-xs text-muted-foreground" aria-live="polite">{rows.length ? tf("ui.models.usage-history.showingRecords", { v0: count, v1: rows.length, v2: count < rows.length ? t("ui.usage.more") : t("ui.usage.allLoaded") }) : t("models.usageEmpty")}</p>
  </div>;
}

export function UsageHistory({ rows, source, onSourceChange, error }: { rows: UsageRow[] | undefined; source: string; onSourceChange: (value: string) => void; error: string }) {
  useLocale();
  return <Sheet><SheetTrigger asChild><Button variant="outline" size="sm"><History aria-hidden="true" />{t("ui.models.usage-history.viewCallDetails")}</Button></SheetTrigger>
    <SheetContent side="right" className="usage-history-sheet flex flex-col" closeLabel={t("ui.models.usage-history.closeCallDetails")}>
      <div className="flex shrink-0 flex-col gap-3 p-5 pr-14"><SheetTitle className="text-lg font-semibold">{t("ui.models.usage-history.modelCallDetails")}</SheetTitle><SheetDescription className="text-xs text-muted-foreground">{t("ui.models.usage-history.last30DaysUpTo100")}</SheetDescription>
        <label className="flex flex-wrap items-center gap-3 text-sm">{t("ui.models.callSource")}<SelectField aria-label={t("ui.models.usage-history.callSourceFilter")} value={source} onValueChange={onSourceChange}><SelectOption value="all">{t("ui.models.allSources")}</SelectOption>{Object.entries(sourceNames()).map(([value, label]) => <SelectOption key={value} value={value}>{label}</SelectOption>)}</SelectField></label>
      </div>
      {error ? <p role="alert" className="px-5 text-sm text-destructive">{localizeMessage(error)}</p> : rows ? <UsageList key={source} rows={rows} /> : <p role="status" className="px-5 text-sm text-muted-foreground">{t("ui.models.usage-history.loadingCallRecords")}</p>}
    </SheetContent>
  </Sheet>;
}
