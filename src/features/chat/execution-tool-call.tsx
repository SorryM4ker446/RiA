"use client";

import { useState } from "react";
import { readToolError } from "@/lib/ai/ui-message";
import { ChevronRight } from "lucide-react";
import { t, tf, localizeMessage } from "@/lib/locale";
import { useLocale } from "@/lib/locale/client";
import { Button } from "@/components/ui/button";
import { TerminalResult, terminalStatusLabels } from "./terminal-result";
import { DiffText } from "./diff-text";
import { formatToolState, safeJson } from "./page-utils";
import { executionGuidance } from "@/lib/execution-messages";
import type { ExecutionCall } from "./execution-calls";

export function ExecutionToolCall({ call, isLatest, waiting, onReviewApproval }: {
  call: ExecutionCall; isLatest: boolean; waiting: boolean; onReviewApproval: () => void;
}) {
  useLocale();
  const { part, step } = call;
  const terminal = part?.type === "tool-runTerminalCommand";
  // Edits show the diff that was approved or written rather than their raw arguments.
  const editSource = part?.type === "tool-editProjectFile"
    ? (part.state === "output-available" ? part.output : (part.input as { binding?: unknown } | undefined)?.binding) as { path?: unknown; diff?: unknown } | undefined : undefined;
  const edit = typeof editSource?.diff === "string" ? { path: String(editSource.path ?? ""), diff: editSource.diff } : null;
  const pendingApproval = part?.state === "approval-requested" && "approval" in part && part.approval;
  const executing = part?.state === "input-available" || (part?.state === "approval-responded" && "approval" in part && !!part.approval?.approved);
  const stoppedStep = step && ["cancelled", "failed", "denied"].includes(step.state) && part?.state !== "output-available";
  // A command started in the background returned while it kept running; its card follows it live.
  const startedInBackground = terminal && part?.state === "output-available" && !!part.output && typeof part.output === "object"
    && (part.output as { background?: unknown; status?: unknown }).background === true && (part.output as { status?: unknown }).status === "running";
  // A call opens while it awaits approval or runs, and closes again once it settles.
  const defaultExpanded = !!pendingApproval || !!(isLatest && (executing || startedInBackground) && !stoppedStep);
  // Saved summaries can arrive before full details. Only an explicit user
  // choice should override the default when those details become available.
  const [expanded, setExpanded] = useState<boolean>();
  // A command that ran but did not succeed says how it ended, so a folded call
  // reads "stopped" rather than "finished" (the call itself did return).
  const terminalStatus = terminal && part?.state === "output-available" && part.output && typeof part.output === "object" && "status" in part.output ? String(part.output.status) : "";
  const state = startedInBackground ? t("ui.chat.terminal-result.startedInBackground")
    : ["stopped", "failed", "timed-out"].includes(terminalStatus) ? terminalStatusLabels()[terminalStatus as "stopped" | "failed" | "timed-out"]
    : part && !stoppedStep
    ? (part.state === "output-available" && part.output && typeof part.output === "object" && "skipped" in part.output && part.output.skipped
      ? t("runs.step.skipped") : formatToolState(part.state).label)
    : step?.state === "done" ? formatToolState("output-available").label : step ? t(`runs.step.${step.state}`) : "";
  const toolName = part?.type.replace(/^tool-/, "") ?? step?.toolName ?? step?.kind ?? "";
  // What the Auto rule's review decided, when the call went through one.
  const reviewed = (part?.input as { autoReview?: { decision?: unknown; reason?: unknown } } | undefined)?.autoReview;
  const autoReview = reviewed && (reviewed.decision === "allow" || reviewed.decision === "ask") ? { decision: reviewed.decision, reason: typeof reviewed.reason === "string" ? reviewed.reason.trim() : "" } : null;
  const name = localizeMessage(part?.title ?? (toolName === "runTerminalCommand" ? t("ui.chat.approval-dock.runTerminalCommand") : toolName));

  return <details className="execution-disclosure text-xs" data-call-id={part?.toolCallId ?? step?.toolCallId ?? step?.id}
    open={expanded ?? defaultExpanded}>
    <summary onClick={event => {
      event.preventDefault();
      setExpanded(current => !(current ?? defaultExpanded));
    }}><ChevronRight aria-hidden="true" /><span className="min-w-0 truncate">{tf("chat.messages.toolDetails", { name, state, extra: "" })}</span></summary>
    <div className="flex min-w-0 flex-col gap-2 py-2">
      {part ? <>
        {autoReview ? <p className="text-[11px] text-muted-foreground">{autoReview.decision === "allow"
          ? tf("ui.chat.execution-tool-call.autoReviewAllowed", { reason: autoReview.reason })
          : autoReview.reason ? tf("ui.chat.approval-dock.autoReviewAsked", { reason: autoReview.reason }) : t("ui.chat.approval-dock.autoReviewFailed")}</p> : null}
        {terminal ? <TerminalResult input={part.input} output={part.state === "output-available" ? part.output : undefined} active={!!executing} /> : null}
        {edit ? <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[11px] text-muted-foreground">{t("ui.chat.approval-dock.file")}{edit.path}</p>
          <pre aria-label={t("ui.chat.approval-dock.changesAwaitingApproval")} className="execution-code chat-list-scroll"><DiffText diff={edit.diff} /></pre>
        </div> : null}
        {!terminal && !edit && part.input !== undefined ? <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[11px] text-muted-foreground">{t("ui.chat.execution-turn-details.inputParameters")}</p>
          <pre className="execution-code chat-list-scroll">{safeJson(part.input && typeof part.input === "object" && "arguments" in part.input && ("binding" in part.input || "autoReview" in part.input) ? part.input.arguments : part.input)}</pre>
        </div> : null}
        {pendingApproval ? <Button disabled={!isLatest || !!stoppedStep} onClick={onReviewApproval} size="sm" type="button" variant="outline" className="w-fit">{t("ui.chat.execution-turn-details.returnToChatToApprove")}</Button> : null}
        {!terminal && !edit && part.state === "output-available" && part.output !== undefined ? <div className="flex min-w-0 flex-col gap-1">
          <p className="text-[11px] text-muted-foreground">{t("ui.chat.execution-turn-details.executionResult")}</p>
          <pre className="execution-code chat-list-scroll">{safeJson(part.output)}</pre>
        </div> : null}
        {part.state === "output-error" && part.errorText ? <p className="break-words leading-5 text-destructive">{readToolError(part.errorText)}</p> : null}
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
