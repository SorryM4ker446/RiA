"use client";
import { useLocale } from "@/lib/locale/client";

import { t } from "@/lib/locale";

import { ChevronRight } from "lucide-react";
import { MarkdownMessage } from "@/components/chat/markdown-message";
import type { ToolMemoryPresentation } from "./entry-presentation";

export function KnowledgeEntryContent({ entryKey, value, toolMemory }: { entryKey: string; value: string; toolMemory: ToolMemoryPresentation | null }) {
  useLocale();
  if (toolMemory) return <div className="flex min-w-0 flex-col gap-2">
    <p className="line-clamp-2 break-words text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">{toolMemory.summary}</p>
    <details className="settings-disclosure knowledge-disclosure group/record">
      <summary className="knowledge-entry-disclosure inline-flex cursor-pointer items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground"><span className="group-open/record:hidden">{t("ui.knowledge.entry-content.viewContent")}</span><span className="hidden group-open/record:inline">{t("ui.knowledge.entry-content.collapseContent")}</span><ChevronRight className="size-3.5 transition-transform duration-[--dur-fast] group-open/record:rotate-90" aria-hidden="true" /></summary>
      <div className="flex min-w-0 flex-col gap-4 pb-1 pt-3">
        {toolMemory.excerpt && <section aria-label={t("ui.knowledge.entry-content.answerExcerpt")} className="knowledge-entry-excerpt min-w-0"><h4 className="mb-2 text-xs font-medium text-muted-foreground">{t("ui.knowledge.entry-content.answerExcerpt")}</h4><MarkdownMessage text={toolMemory.excerpt} allowImages={false} /></section>}
        <details className="knowledge-disclosure group/raw"><summary className="knowledge-entry-disclosure inline-flex cursor-pointer items-center gap-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground">{t("ui.knowledge.entry-content.originalRecord")}<ChevronRight className="size-3.5 transition-transform duration-[--dur-fast] group-open/raw:rotate-90" aria-hidden="true" /></summary><div className="flex min-w-0 flex-col gap-2 pt-3"><p className="break-all text-xs text-muted-foreground">{entryKey}</p><pre className="chat-list-scroll max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-xs leading-6 [overflow-wrap:anywhere]">{value}</pre></div></details>
      </div>
    </details>
  </div>;
  if (value.length <= 240 && value.split(/\r?\n/).length <= 3) return <p className="whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">{value}</p>;
  return <details className="settings-disclosure knowledge-disclosure group/entry">
    <summary className="knowledge-entry-disclosure flex cursor-pointer flex-col items-start gap-1.5 text-sm leading-6 text-muted-foreground"><span className="line-clamp-2 whitespace-pre-wrap break-words group-open/entry:hidden [overflow-wrap:anywhere]">{value.slice(0, 240)}{value.length > 240 ? "…" : ""}</span><span className="inline-flex items-center gap-1 text-xs group-open/entry:hidden">{t("ui.knowledge.entry-content.expandFullText")}<ChevronRight className="size-3.5" aria-hidden="true" /></span><span className="hidden text-xs group-open/entry:inline">{t("ui.knowledge.entry-content.collapseFullText")}</span></summary>
    <p className="whitespace-pre-wrap break-words pt-3 text-sm leading-7 [overflow-wrap:anywhere]">{value}</p>
  </details>;
}
