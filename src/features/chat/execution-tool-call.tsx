"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { t, tf, localizeMessage } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { Button } from "@/components/ui/button";
import { TerminalResult } from "./terminal-result";
import { formatToolState, safeJson } from "./page-utils";
import { executionGuidance } from "@/lib/execution-messages";
import type { ExecutionCall } from "./execution-calls";

export function ExecutionToolCall({ call, isLatest, waiting, onReviewApproval }: {
  call: ExecutionCall; isLatest: boolean; waiting: boolean; onReviewApproval: () => void;
}) {
  useLocale();
  const { part, step } = call;
  const terminal = part?.type === "tool-runTerminalCommand";
  const pendingApproval = part?.state === "approval-requested" && "approval" in part && part.approval;
  const terminalActive = part?.state === "input-available" || (part?.state === "approval-responded" && "approval" in part && !!part.approval?.approved);
  const defaultExpanded = !!pendingApproval || !!(terminal && isLatest && (terminalActive || part?.state === "output-available"));
  // Saved summaries can arrive before terminal details. Only an explicit user
  // choice should override the default when those details become available.
  const [expanded, setExpanded] = useState<boolean>();
  const stoppedStep = step && ["cancelled", "failed", "denied"].includes(step.state) && part?.state !== "output-available";
  const state = part && !stoppedStep
    ? (part.state === "output-available" && part.output && typeof part.output === "object" && "skipped" in part.output && part.output.skipped
      ? t("runs.step.skipped") : formatToolState(part.state).label)
    : step?.state === "done" ? formatToolState("output-available").label : step ? t(`runs.step.${step.state}`) : "";
  const toolName = part?.type.replace(/^tool-/, "") ?? step?.toolName ?? step?.kind ?? "";
  const name = localizeMessage(part?.title ?? (toolName === "runTerminalCommand" ? t("ui.chat.approval-dock.runTerminalCommand") : toolName));

  return <details className="execution-disclosure text-xs" data-call-id={part?.toolCallId ?? step?.toolCallId ?? step?.id}
    open={expanded ?? defaultExpanded}>
    <summary onClick={event => {
      event.preventDefault();
      setExpanded(current => !(current ?? defaultExpanded));
    }}><ChevronRight aria-hidden="true" /><span className="min-w-0 truncate">{tf("chat.messages.toolDetails", { name, state, extra: "" })}</span></summary>
    <div className="flex min-w-0 flex-col gap-2 py-2">
      {part ? <>
        {terminal ? <TerminalResult input={part.input} output={part.state === "output-available" ? part.output : undefined} active={!!terminalActive} /> : null}
        {!terminal && part.input !== undefined ? <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[11px] text-muted-foreground">{t("ui.chat.execution-turn-details.inputParameters")}</p>
          <pre className="execution-code chat-list-scroll">{safeJson(part.input && typeof part.input === "object" && "arguments" in part.input && "binding" in part.input ? part.input.arguments : part.input)}</pre>
        </div> : null}
        {pendingApproval ? <Button disabled={!isLatest || !!stoppedStep} onClick={onReviewApproval} size="sm" type="button" variant="outline" className="w-fit">{t("ui.chat.execution-turn-details.returnToChatToApprove")}</Button> : null}
        {!terminal && part.state === "output-available" && part.output !== undefined ? <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[11px] text-muted-foreground">{t("ui.chat.execution-turn-details.executionResult")}</p>
          <pre className="execution-code chat-list-scroll">{safeJson(part.output)}</pre>
        </div> : null}
        {part.state === "output-error" && part.errorText ? <p className="break-words leading-5 text-destructive">{part.errorText}</p> : null}
      </> : <>
        <p role="status" className="leading-5 text-muted-foreground">{t(waiting ? "ui.chat.run-records.waitingForDetails" : "ui.chat.run-records.detailsUnavailable")}</p>
        {step?.input != null || step?.output != null ? <>
          <p className="text-[11px] text-muted-foreground">{t("ui.chat.run-records.savedStepSummary")}</p>
          <pre className="execution-code chat-list-scroll">{safeJson({ input: step?.input, output: step?.output })}</pre>
        </> : null}
      </>}
      {step?.errorCode ? <p className="break-words leading-5 text-destructive">{executionGuidance(step.errorCode)}</p> : null}
    </div>
  </details>;
}
