"use client";

import { useId, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import { t } from "@/lib/locale";
import { isToolPart, safeJson, type ToolPart } from "./page-utils";
import type { ChatState } from "./use-chat-state";

type Props = Pick<ChatState, "messages" | "isPending" | "addToolApprovalResponse"> & { onDetails: (messageId: string) => void };

export function ApprovalDock({ messages, isPending, addToolApprovalResponse, onDetails }: Props) {
  const message = messages.at(-1);
  if (message?.role !== "assistant") return null;
  const tools = message.parts.filter(isToolPart);
  const pending = tools.filter(part => part.state === "approval-requested" && "approval" in part && !!part.approval);
  return pending.length ? <ApprovalRequest key={`${message.id}:${pending[0].toolCallId}`} part={pending[0]} count={pending.length} disabled={isPending} respond={addToolApprovalResponse} onDetails={() => onDetails(message.id)} /> : null;
}

function ApprovalRequest({ part, count, disabled, respond, onDetails }: {
  part: ToolPart; count: number; disabled: boolean;
  respond: ChatState["addToolApprovalResponse"]; onDetails: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailsId = useId();
  const busy = useRef(false);
  const approval = "approval" in part ? part.approval : undefined;
  const input = part.input as { command?: unknown; binding?: { cwd?: unknown }; arguments?: unknown } | undefined;
  const terminal = part.type === "tool-runTerminalCommand";
  const command = terminal && typeof input?.command === "string" ? input.command : safeJson(input?.arguments ?? part.input);
  async function decide(approved: boolean) {
    if (!approval || disabled || busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError(null);
    try { await respond({ id: approval.id, approved, ...(!approved ? { reason: t("chat.messages.approvalRejectedReason") } : {}) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "审批失败，请重试。"); }
    finally { busy.current = false; setSubmitting(false); }
  }
  return <Card id="chat-approval-card" role="region" aria-label="操作审批" tabIndex={-1} className="approval-card mx-auto w-full max-w-[42rem] shrink-0">
    <CardHeader className="flex-row items-center gap-2 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2"><Badge variant="warning">待批准</Badge><CardTitle className="min-w-0 truncate text-sm">{part.title ?? (terminal ? "执行终端命令" : part.type.replace(/^tool-/, ""))}</CardTitle></div>
        <CardDescription role="status" className="sr-only">{t("chat.messages.approvalPending")}</CardDescription>
        {terminal ? <p className="truncate text-xs text-muted-foreground" title={typeof input?.binding?.cwd === "string" ? input.binding.cwd : undefined}>工作目录：{typeof input?.binding?.cwd === "string" ? input.binding.cwd : "等待验证目录"}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" disabled={disabled || submitting} onClick={event => { if (event.detail <= 1) void decide(true); }}>{submitting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}{t("chat.messages.approve")}</Button>
        <Button size="sm" variant="outline" disabled={disabled || submitting} onClick={event => { if (event.detail <= 1) void decide(false); }}><X data-icon="inline-start" />{t("chat.messages.reject")}</Button>
      </div>
    </CardHeader>
    <div id={detailsId} className="approval-details" data-state={expanded ? "open" : "closed"} aria-hidden={!expanded} inert={!expanded}>
      <div className="min-h-0 overflow-hidden">
        <CardContent className="px-3 pb-1 pt-0">
          <pre aria-label={terminal ? "PowerShell 命令" : "待审批参数"} className="execution-code chat-list-scroll" tabIndex={expanded ? 0 : -1}>{command}</pre>
        </CardContent>
      </div>
    </div>
    {error ? <p role="alert" className="px-3 pb-1 text-xs text-destructive">{error}</p> : null}
    <CardFooter className="flex-wrap gap-1 px-2 pb-1 pt-0">
      <Button size="sm" variant="ghost" aria-controls={detailsId} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ChevronDown data-icon="inline-start" className={cn("transition-transform duration-[--dur-fast] motion-reduce:transition-none", expanded && "rotate-180")} />{expanded ? "收起详情" : "查看详情"}</Button>
      {count > 1 ? <span className="text-xs text-muted-foreground">还有 {count - 1} 项</span> : null}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onDetails}>执行详情</Button>
    </CardFooter>
  </Card>;
}
