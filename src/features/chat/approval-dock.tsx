"use client";
import { useLocale } from "@/lib/locale/client";

import { t, tf, localizeMessage } from "@/lib/locale";

import { useId, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/cn";
import { isToolPart, safeJson, type ToolPart } from "./page-utils";
import type { ChatState } from "./use-chat-state";
import { CommandText } from "./command-text";
import { DiffText } from "./diff-text";

type Props = Pick<ChatState, "messages" | "isPending" | "addToolApprovalResponse"> & { onDetails: (messageId: string) => void };

export function ApprovalDock({ messages, isPending, addToolApprovalResponse, onDetails }: Props) {
  useLocale();
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
  useLocale();
  const [detailsState, setDetailsState] = useState<"unopened" | "open" | "closed">("unopened");
  const expanded = detailsState === "open";
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detailsId = useId();
  const busy = useRef(false);
  const approval = "approval" in part ? part.approval : undefined;
  const input = part.input as { command?: unknown; binding?: { cwd?: unknown; path?: unknown; diff?: unknown; added?: unknown; removed?: unknown; stale?: unknown }; arguments?: unknown } | undefined;
  const terminal = part.type === "tool-runTerminalCommand";
  // An edit is approved by the diff the server computed from the file, never by its raw arguments.
  const edit = part.type === "tool-editProjectFile" && typeof input?.binding?.diff === "string" ? input.binding as { path?: unknown; diff: string; added?: unknown; removed?: unknown; stale?: unknown } : null;
  const command = detailsState === "unopened" ? "" : terminal && typeof input?.command === "string" ? input.command : edit ? edit.diff : safeJson(input?.arguments ?? part.input);
  async function decide(approved: boolean) {
    if (!approval || disabled || busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError(null);
    try { await respond({ id: approval.id, approved, ...(!approved ? { reason: t("chat.messages.approvalRejectedReason") } : {}) }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("ui.chat.approval-dock.approvalFailedPleaseTryAgain")); }
    finally { busy.current = false; setSubmitting(false); }
  }
  return <Card id="chat-approval-card" role="region" aria-label={t("ui.chat.approval-dock.actionApproval")} tabIndex={-1} className="approval-card mx-auto w-full max-w-[42rem] shrink-0">
    <CardHeader className="flex-row items-center gap-2 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2"><Badge variant="warning">{t("ui.chat.approval-dock.pendingApproval")}</Badge><CardTitle className="min-w-0 truncate text-sm">{localizeMessage(part.title ?? (terminal ? t("ui.chat.approval-dock.runTerminalCommand") : part.type.replace(/^tool-/, "")))}</CardTitle></div>
        <CardDescription role="status" className="sr-only">{t("chat.messages.approvalPending")}</CardDescription>
        {terminal ? <p className="truncate text-xs text-muted-foreground" title={typeof input?.binding?.cwd === "string" ? input.binding.cwd : undefined}>{t("ui.chat.approval-dock.workingDirectory")}{typeof input?.binding?.cwd === "string" ? input.binding.cwd : t("ui.chat.approval-dock.waitingForDirectoryValidation")}</p> : null}
        {edit ? <p className="truncate text-xs text-muted-foreground" title={String(edit.path ?? "")}>{t("ui.chat.approval-dock.file")}{String(edit.path ?? "")} {tf("ui.chat.approval-dock.changeCounts", { added: Number(edit.added ?? 0), removed: Number(edit.removed ?? 0) })}</p> : null}
        {edit?.stale ? <p role="alert" className="text-xs text-destructive">{t("ui.chat.approval-dock.staleEdit")}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" disabled={disabled || submitting} onClick={event => { if (event.detail <= 1) void decide(true); }}>{submitting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}{t("chat.messages.approve")}</Button>
        <Button size="sm" variant="outline" disabled={disabled || submitting} onClick={event => { if (event.detail <= 1) void decide(false); }}><X data-icon="inline-start" />{t("chat.messages.reject")}</Button>
      </div>
    </CardHeader>
    <div id={detailsId} className="approval-details" data-state={expanded ? "open" : "closed"} aria-hidden={!expanded} inert={!expanded}>
      <div className="min-h-0 overflow-hidden">
        <CardContent className="px-3 pb-1 pt-0">
          {detailsState !== "unopened" ? <pre aria-label={terminal ? t("ui.chat.approval-dock.powerShellCommand") : edit ? t("ui.chat.approval-dock.changesAwaitingApproval") : t("ui.chat.approval-dock.parametersAwaitingApproval")} className="execution-code chat-list-scroll" tabIndex={expanded ? 0 : -1}>{terminal ? <CommandText command={command} /> : edit ? <DiffText diff={command} /> : command}</pre> : null}
        </CardContent>
      </div>
    </div>
    {error ? <p role="alert" className="px-3 pb-1 text-xs text-destructive">{localizeMessage(error)}</p> : null}
    <CardFooter className="flex-wrap gap-1 px-2 pb-1 pt-0">
      <Button size="sm" variant="ghost" aria-controls={detailsId} aria-expanded={expanded} onClick={() => setDetailsState(value => value === "open" ? "closed" : "open")}><ChevronDown data-icon="inline-start" className={cn("transition-transform duration-[--dur-fast] motion-reduce:transition-none", expanded && "rotate-180")} />{expanded ? t("ui.chat.approval-dock.collapseDetails") : t("media.viewDetails")}</Button>
      {count > 1 ? <span className="text-xs text-muted-foreground">{tf("ui.chat.approval-dock.more", { count: count - 1 })}</span> : null}
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onDetails}>{t("ui.chat.approval-dock.executionDetails")}</Button>
    </CardFooter>
  </Card>;
}
