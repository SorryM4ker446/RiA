"use client";
import type { UIMessage } from "ai";
import { useLocale } from "@/lib/locale/client";
import { t, tf, type MessageKey } from "@/lib/locale";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { latestContextReport, type ContextReport } from "@/lib/chat/context-report";
import { cn } from "@/lib/utils/cn";

/** Compact token counts, as a reader scans them: 443.3k, 1M. */
function formatTokens(tokens: number) {
  const rounded = (value: number) => (Math.round(value * 10) / 10).toString();
  if (tokens >= 1_000_000) return `${rounded(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${rounded(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

/** What a request is made of. Colors follow the entry, whatever its share. */
function compositionRows(breakdown: NonNullable<ContextReport["breakdown"]>) {
  const rows: { key: string; label: MessageKey; tokens: number; color: string }[] = [
    { key: "messages", label: "chat.composer.contextPartMessages", tokens: breakdown.messages, color: "context-part-1" },
    { key: "toolResults", label: "chat.composer.contextPartToolResults", tokens: breakdown.toolResults, color: "context-part-2" },
    { key: "summary", label: "chat.composer.contextPartSummary", tokens: breakdown.summary, color: "context-part-3" },
    { key: "system", label: "chat.composer.contextPartSystem", tokens: breakdown.system, color: "context-part-4" },
    { key: "tools", label: "chat.composer.contextPartTools", tokens: breakdown.tools, color: "context-part-5" },
    { key: "extensionTools", label: "chat.composer.contextPartExtensionTools", tokens: breakdown.extensionTools, color: "context-part-6" },
    { key: "skills", label: "chat.composer.contextPartSkills", tokens: breakdown.skills, color: "context-part-7" },
    { key: "reference", label: "chat.composer.contextPartReference", tokens: breakdown.reference, color: "context-part-8" },
  ];
  return rows.filter(row => row.tokens > 0);
}

/**
 * A quiet indicator of how much of the model's window the last request used.
 * It stays muted until compaction is near, and on hover shows what the window holds.
 */
export function ContextUsage({ messages, freedTokens = 0 }: { messages: UIMessage[]; freedTokens?: number }) {
  useLocale();
  const report = latestContextReport(messages);
  if (!report) return null;
  const { contextWindow, triggerTokens } = report.budget;
  // What the provider counted, when it said; otherwise the estimate made before sending.
  const usedTokens = Math.max(0, (report.measuredInputTokens ?? report.estimatedInputTokens) - freedTokens);
  const used = Math.min(1, usedTokens / contextWindow);
  const trigger = triggerTokens ? triggerTokens / contextWindow : null;
  const near = trigger !== null && used >= trigger * 0.85;
  const percent = Math.round(used * 100);
  const circumference = 2 * Math.PI * 5;
  // The parts are estimates: their proportions divide up the count above, so they add up to it.
  const estimated = report.breakdown ? compositionRows(report.breakdown) : [];
  const estimatedTotal = estimated.reduce((sum, row) => sum + row.tokens, 0);
  const parts = estimated.map(row => ({ ...row, tokens: estimatedTotal ? row.tokens / estimatedTotal * usedTokens : 0 }));
  const buffer = triggerTokens ? Math.max(0, contextWindow - triggerTokens) : 0;
  const free = Math.max(0, contextWindow - usedTokens - buffer);
  const share = (tokens: number) => `${(tokens / contextWindow * 100).toFixed(1)}%`;
  const row = (key: string, label: string, tokens: number, swatch: string) => <div key={key} className="context-usage-row">
    <span aria-hidden="true" className={cn("context-usage-swatch", swatch)} />
    <span className="min-w-0 truncate">{label}</span>
    <span className="flex items-center justify-end tabular-nums">
      <span className="context-usage-tokens">{formatTokens(tokens)}</span>
      <span className="text-popover-foreground">{share(tokens)}</span>
    </span>
  </div>;
  return <TooltipProvider delayDuration={300}><Tooltip>
    <TooltipTrigger asChild>
      <span tabIndex={0} data-state={near ? "near" : "normal"} aria-label={tf("chat.composer.contextUsageLabel", { percent })}
        className={cn("inline-flex h-7 shrink-0 cursor-default select-none items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums text-muted-foreground/80 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring", near && "text-foreground")}>
        <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3 -rotate-90">
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
          <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={circumference * (1 - used)} />
        </svg>
        {percent}%
      </span>
    </TooltipTrigger>
    <TooltipContent side="top" align="center" className="context-usage-card">
      <div className="flex items-baseline justify-between gap-3 tabular-nums">
        <span className="text-popover-foreground">{t("chat.composer.contextUsageTitle")}</span>
        <span className="text-popover-foreground">{percent}%</span>
      </div>
      <div aria-hidden="true" className="context-usage-bar">
        {parts.length ? parts.map(item => <span key={item.key} className={item.color} style={{ width: `${item.tokens / contextWindow * 100}%` }} />)
          : <span className="context-part-1" style={{ width: `${used * 100}%` }} />}
        {buffer ? <i className="context-usage-buffer" style={{ width: `${buffer / contextWindow * 100}%` }} /> : null}
      </div>
      {parts.length ? <div className="context-usage-rows">
        {parts.map(item => row(item.key, t(item.label), item.tokens, item.color))}
        <div className="context-usage-divider" />
        {buffer ? row("buffer", t("chat.composer.contextPartBuffer"), buffer, "context-part-buffer") : null}
        {row("free", t("chat.composer.contextPartFree"), free, "context-part-free")}
      </div> : null}
    </TooltipContent>
  </Tooltip></TooltipProvider>;
}
