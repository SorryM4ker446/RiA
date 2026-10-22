"use client";
import type { UIMessage } from "ai";
import { useLocale } from "@/lib/locale/client";
import { formatNumber, tf } from "@/lib/locale";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { latestContextReport } from "@/lib/chat/context-report";
import { cn } from "@/lib/utils/cn";

/**
 * A quiet indicator of how much of the model's window the last request used.
 * It stays muted until compaction is near, and explains itself on hover.
 */
export function ContextUsage({ messages }: { messages: UIMessage[] }) {
  useLocale();
  const report = latestContextReport(messages);
  if (!report) return null;
  const { contextWindow, triggerTokens } = report.budget;
  const used = Math.min(1, report.estimatedInputTokens / contextWindow);
  const trigger = triggerTokens ? triggerTokens / contextWindow : null;
  const near = trigger !== null && used >= trigger * 0.85;
  const percent = Math.round(used * 100);
  const circumference = 2 * Math.PI * 5;
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
    <TooltipContent side="top" className="max-w-64 leading-5">
      <p>{tf("chat.composer.contextUsageDetail", { used: formatNumber(report.estimatedInputTokens), window: formatNumber(contextWindow) })}</p>
      {trigger !== null ? <p className="text-muted-foreground">{tf("chat.composer.contextUsageTrigger", { percent: Math.round(trigger * 100) })}</p> : null}
      {report.compactions > 0 ? <p className="text-muted-foreground">{tf("chat.composer.contextUsageCompacted", { count: report.compactions })}</p> : null}
    </TooltipContent>
  </Tooltip></TooltipProvider>;
}
