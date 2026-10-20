"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf } from "@/lib/locale";

import type { UIMessage } from "ai";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DocumentSources } from "@/components/knowledge/document-sources";
import { RetrievalDiagnostics } from "@/components/knowledge/retrieval-diagnostics";
import { LocalFileUses } from "@/features/settings/local-file-uses";
import { isToolPart } from "./page-utils";
import type { RunView } from "@/lib/agent/runs";
import { executionCalls } from "./execution-calls";
import { ExecutionToolCall } from "./execution-tool-call";
import { getDocumentSources, getLocalFileUses, getWebSearchSources } from "./message-presentation";
import { contextReportSchema } from "@/lib/chat/context-report";

type Props = { message?: UIMessage; run?: RunView; isLatest: boolean; loading?: boolean; onReviewApproval: () => void };

export function ExecutionTurnDetails({ message, run, isLatest, loading = false, onReviewApproval }: Props) {
  useLocale();
  const toolParts = message?.parts.filter(isToolPart) ?? [];
  const calls = executionCalls(run, message);
  const waiting = loading || run?.status === "running" || run?.status === "waiting_approval";
  const webSources = getWebSearchSources(toolParts);
  const documentSources = message ? getDocumentSources(message) : [];
  const localFiles = message ? getLocalFileUses(message) : [];
  const sourceCount = webSources.length + documentSources.length + localFiles.length;
  const metadata = message?.metadata as { documentDiagnostics?: unknown; modelLabel?: string; contextBudget?: unknown } | undefined;
  const contextReport = contextReportSchema.safeParse(metadata?.contextBudget);

  return <section className="execution-turn-details flex min-w-0 flex-col gap-4" aria-label={t("ui.chat.execution-entries.toolAndSourceDetails")}>
    {calls.length > 0 ? <section className="flex min-w-0 flex-col gap-1" aria-label={t("models.catalog.toolCall")}>
      <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">{t("models.catalog.toolCall")}<Badge variant="secondary">{calls.length}</Badge></div>
      {toolParts.some(part => part.state === "approval-requested") ? <p role="status" className="py-1 text-xs text-muted-foreground">{t("chat.messages.approvalPending")}</p> : null}
      {calls.map(call => <ExecutionToolCall key={call.key} call={call} isLatest={isLatest} waiting={waiting} onReviewApproval={onReviewApproval} />)}
    </section> : null}
    {sourceCount > 0 ? <section className="flex min-w-0 flex-col gap-1" aria-label={t("ui.chat.execution-turn-details.sourcesUsed")}>
      <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">{t("ui.chat.execution-turn-details.sourcesUsed")}<Badge variant="secondary">{sourceCount}</Badge></div>
      {webSources.length > 0 ? <details className="execution-disclosure text-xs">
        <summary><ChevronRight aria-hidden="true" />{tf("chat.messages.searchSourcesPrefix", { count: webSources.length })}</summary>
        <ol className="flex min-w-0 flex-col gap-3 py-2 pl-5">
          {webSources.map((source, index) => <li className="min-w-0 break-words leading-5" key={`${source.url}-${index}`}>
            <a className="font-medium underline decoration-border underline-offset-4 transition-colors duration-[--dur-fast] hover:decoration-foreground" href={source.url} rel="noreferrer" target="_blank">{index + 1}. {source.title}</a>
            {source.snippet ? <p className="mt-1 line-clamp-3 text-muted-foreground">{source.snippet}</p> : null}
          </li>)}
        </ol>
      </details> : null}
      <DocumentSources sources={documentSources} compact />
      {localFiles.length > 0 ? <details className="execution-disclosure text-xs">
        <summary><ChevronRight aria-hidden="true" />{t("ui.chat.execution-turn-details.localFiles")}{localFiles.length}）</summary>
        <LocalFileUses uses={localFiles} modelLabel={metadata?.modelLabel} compact />
      </details> : null}
    </section> : null}
    <RetrievalDiagnostics value={metadata?.documentDiagnostics} compact />
    {contextReport.success && contextReport.data.compactions > 0 ? <p className="text-xs text-muted-foreground">{tf("chat.context.compacted", { count: contextReport.data.compactions })}{contextReport.data.degraded ? ` ${t("chat.context.degraded")}` : ""}</p> : null}
  </section>;
}
