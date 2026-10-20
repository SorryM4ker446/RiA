"use client";

import type { UIMessage } from "ai";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DocumentSources } from "@/components/knowledge/document-sources";
import { RetrievalDiagnostics } from "@/components/knowledge/retrieval-diagnostics";
import { LocalFileUses } from "@/features/settings/local-file-uses";
import { t, tf } from "@/lib/locale";
import { TerminalResult } from "./terminal-result";
import { formatToolState, isToolPart, safeJson, type ToolPart } from "./page-utils";
import { getDocumentSources, getLocalFileUses, getWebSearchSources } from "./message-presentation";

type Props = { message: UIMessage; isLatest: boolean; onReviewApproval: () => void };

function executionToolState(part: ToolPart) {
  return part.state === "output-available" && part.output && typeof part.output === "object" && "skipped" in part.output && part.output.skipped
    ? { label: "已跳过", variant: "secondary" as const }
    : formatToolState(part.state);
}

export function ExecutionTurnDetails({ message, isLatest, onReviewApproval }: Props) {
  const toolParts = message.parts.filter(isToolPart);
  const webSources = getWebSearchSources(toolParts);
  const documentSources = getDocumentSources(message);
  const localFiles = getLocalFileUses(message);
  const sourceCount = webSources.length + documentSources.length + localFiles.length;
  const metadata = message.metadata as { documentDiagnostics?: unknown; modelLabel?: string } | undefined;

  return <section className="execution-turn-details flex min-w-0 flex-col gap-4" aria-label="工具与资料详情">
    {toolParts.length > 0 ? <section className="flex min-w-0 flex-col gap-1" aria-label="工具调用">
      <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">工具调用<Badge variant="secondary">{toolParts.length}</Badge></div>
      {toolParts.some(part => part.state === "approval-requested") ? <p role="status" className="py-1 text-xs text-muted-foreground">{t("chat.messages.approvalPending")}</p> : null}
      {toolParts.map((part, index) => {
        const state = executionToolState(part);
        const name = part.title ?? part.type.replace(/^tool-/, "");
        const terminal = part.type === "tool-runTerminalCommand";
        const pendingApproval = part.state === "approval-requested" && "approval" in part && part.approval;
        const terminalActive = part.state === "input-available" || (part.state === "approval-responded" && "approval" in part && !!part.approval?.approved);
        return <details key={`${part.toolCallId}-${index}`} className="execution-disclosure text-xs" open={!!pendingApproval || (terminal && isLatest && (terminalActive || part.state === "output-available")) || undefined}>
          <summary><ChevronRight aria-hidden="true" /><span className="min-w-0 truncate">{tf("chat.messages.toolDetails", { name, state: state.label, extra: "" })}</span></summary>
          <div className="flex min-w-0 flex-col gap-2 py-2">
            {terminal ? <TerminalResult input={part.input} output={part.state === "output-available" ? part.output : undefined} active={terminalActive} /> : null}
            {!terminal && part.input !== undefined ? <div className="flex min-w-0 flex-col gap-1">
              <p className="text-[11px] text-muted-foreground">输入参数</p>
              <pre className="execution-code chat-list-scroll">{safeJson(part.input && typeof part.input === "object" && "arguments" in part.input && "binding" in part.input ? part.input.arguments : part.input)}</pre>
            </div> : null}
            {pendingApproval ? <Button disabled={!isLatest} onClick={onReviewApproval} size="sm" type="button" variant="outline" className="w-fit">返回聊天批准</Button> : null}
            {!terminal && part.state === "output-available" && part.output !== undefined ? <div className="flex min-w-0 flex-col gap-1">
              <p className="text-[11px] text-muted-foreground">执行结果</p>
              <pre className="execution-code chat-list-scroll">{safeJson(part.output)}</pre>
            </div> : null}
            {part.state === "output-error" && part.errorText ? <p className="break-words leading-5 text-destructive">{part.errorText}</p> : null}
          </div>
        </details>;
      })}
    </section> : null}
    {sourceCount > 0 ? <section className="flex min-w-0 flex-col gap-1" aria-label="使用资料">
      <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">使用资料<Badge variant="secondary">{sourceCount}</Badge></div>
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
        <summary><ChevronRight aria-hidden="true" />本地文件（{localFiles.length}）</summary>
        <LocalFileUses uses={localFiles} modelLabel={metadata?.modelLabel} compact />
      </details> : null}
    </section> : null}
    <RetrievalDiagnostics value={metadata?.documentDiagnostics} compact />
  </section>;
}
