"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  History,
  Loader2,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { getApiErrorMessage } from "@/lib/api-error-message";
import { t } from "@/lib/locale";
import { cn } from "@/lib/utils/cn";
import type { RunView } from "@/lib/agent/runs";
import type { UIMessage } from "ai";
import type { ChatState } from "./use-chat-state";
import { ExecutionTurnDetails } from "./execution-turn-details";
import { isToolPart, safeJson, mapStoredMessagesToUI } from "./page-utils";
import { executionEntries } from "./execution-entries";
import { executionGuidance } from "@/lib/execution-messages";

type Props = Pick<ChatState, "messages"> & {
  activeChatId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  focusedMessageId?: string;
  /** Bumped by the caller when a turn finishes, so the list refreshes with it. */
  refreshKey?: number;
};

/** How often a run in flight is re-read while the turn is still open. */
const ACTIVE_RUN_POLL_MS = 1500;

/**
 * What a turn actually did.
 *
 * Shown rather than hidden because the alternative is trusting that a tool ran
 * because the answer says so. The states are the ones that can be acted on:
 * something is running, something is waiting, something was skipped, or the run
 * stopped on purpose.
 */
export function RunRecords({ activeChatId, refreshKey, messages, open, onOpenChange: setOpen, focusedMessageId }: Props) {
  const [detail, setDetail] = useState<{ key: string; message?: UIMessage; error?: string } | null>(null);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // A runs request outlives the conversation it was asked for, so every load
  // takes a number and only the newest one is allowed to write. Without it,
  // switching conversations mid-request showed the previous conversation's runs
  // under the new one, and a failure left its message on screen for good.
  const runsRequestRef = useRef(0);
  const latestRunId = (messages.at(-1)?.metadata as { runId?: string } | undefined)?.runId;

  /**
   * Whether a turn is still open, from the rows already read.
   *
   * One reading of "is something in flight", shared by the stop button and the
   * poll below: a panel whose button and spinner disagree about the same run is
   * worse than either being briefly wrong.
   */
  const hasActiveRun = runs.some(
    (run) => run.status === "running" || run.status === "waiting_approval",
  );

  const load = useCallback(async () => {
    const requestId = ++runsRequestRef.current;
    if (!activeChatId) {
      setRuns([]);
      setError(null);
      return;
    }
    try {
      const response = await fetch(
        `/api/conversations/${activeChatId}/runs?limit=10`,
        { cache: "no-store" },
      );
      const payload = await response.json();
      if (!response.ok)
        throw new Error(getApiErrorMessage(payload, t("runs.error.load")));
      if (requestId !== runsRequestRef.current) return;
      setRuns(Array.isArray(payload.data) ? payload.data : []);
      // The list is what this panel reports, so a message from an earlier
      // request has nothing left to say once a newer one has answered.
      setError(null);
    } catch (loadError) {
      if (requestId !== runsRequestRef.current) return;
      setError(
        loadError instanceof Error ? loadError.message : t("runs.error.load"),
      );
    }
  }, [activeChatId]);

  useEffect(() => {
    void load();
    return () => {
      runsRequestRef.current += 1;
    };
  }, [load, refreshKey, latestRunId]);

  /**
   * A turn closes its run on the server after the response stream ends, so the
   * refresh that follows a turn can read the row before it is closed and leave
   * a finished turn spinning until something else triggers a load. Re-reading
   * while a run is in flight closes that window: the last poll of a turn that
   * has ended is the one that replaces the stale row.
   *
   * Polling is scoped to the open turn and stops as soon as nothing is running,
   * so a finished conversation costs no further requests. A run the server has
   * closed stops being in flight on the next read, which is also what ends the
   * poll for a turn whose closing write never arrived.
   */
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = setInterval(() => {
      void load();
    }, ACTIVE_RUN_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [hasActiveRun, load]);

  async function stop() {
    if (!activeChatId) return;
    setIsStopping(true);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${activeChatId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      const payload = await response.json();
      if (!response.ok)
        throw new Error(getApiErrorMessage(payload, t("runs.error.stop")));
      setExpanded(null);
      await load();
    } catch (stopError) {
      setError(
        stopError instanceof Error ? stopError.message : t("runs.error.stop"),
      );
    } finally {
      setIsStopping(false);
    }
  }

  const entries = executionEntries(runs, messages);
  const selected = entries.find(entry => entry.key === expanded);
  const liveDetail = selected?.message;
  const selectedRunId = selected?.run?.id;
  useEffect(() => {
    if (open && focusedMessageId) setExpanded(`message:${focusedMessageId}`);
  }, [open, focusedMessageId]);
  useEffect(() => {
    if (!open || !expanded || !selectedRunId || liveDetail || !activeChatId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/conversations/${activeChatId}/runs?runId=${encodeURIComponent(selectedRunId)}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(getApiErrorMessage(payload, "无法读取详情"));
        if (!controller.signal.aborted) setDetail({ key: expanded, message: payload.data ? mapStoredMessagesToUI([payload.data]).uiMessages[0] : undefined });
      } catch (error) {
        if (!controller.signal.aborted) setDetail({ key: expanded, error: error instanceof Error ? error.message : "无法读取详情" });
      }
    })();
    return () => controller.abort();
  }, [activeChatId, expanded, selectedRunId, liveDetail, open, refreshKey]);
  const detailMessage = liveDetail ?? (detail?.key === expanded ? detail.message : undefined);

  if (!activeChatId) return null;

  return (
    <Sheet key={activeChatId} open={open} onOpenChange={setOpen}>
      <div className="run-records flex min-w-0 items-center">
        <SheetTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={t("runs.title")}>
            <History data-icon="inline-start" aria-hidden="true" />
            {t("runs.title")}<Badge variant="secondary">{entries.length}</Badge>
            {error && <span className="text-destructive">读取失败</span>}
            {hasActiveRun && <span className="flex items-center gap-1 text-muted-foreground"><Loader2 className="animate-spin" aria-hidden="true" />执行中</span>}
          </Button>
        </SheetTrigger>
      </div>
      <SheetContent side="right" className="run-records-sheet flex flex-col gap-0 p-0">
        <header className="flex flex-col gap-1 px-5 py-4 pr-12">
          <div className="flex items-center gap-2">
            <SheetTitle className="text-base font-semibold">{t("runs.title")}</SheetTitle>
            <Badge variant="secondary">{entries.length}</Badge>
          </div>
          <SheetDescription className="text-xs text-muted-foreground">请求状态、工具调用与资料来源</SheetDescription>
        </header>
        <Separator />
        <div className="run-records-scroll chat-list-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2">
          {hasActiveRun ? (
            <div className="flex justify-end pb-2">
              <Button disabled={isStopping} onClick={() => void stop()} size="sm" type="button" variant="outline">
                {isStopping ? <Loader2 data-icon="inline-start" className="animate-spin" aria-hidden="true" /> : <Square data-icon="inline-start" className="fill-current" aria-hidden="true" />}
                {t("chat.run.stop")}
              </Button>
            </div>
          ) : null}
          {error ? <p role="alert" className="px-2 py-2 text-xs text-destructive">{error}</p> : null}
          {entries.length === 0 ? (
            <Empty>
              <EmptyHeader><EmptyMedia><History aria-hidden="true" /></EmptyMedia><EmptyDescription>{t("chat.run.empty")}</EmptyDescription></EmptyHeader>
            </Empty>
          ) : null}
          <ul className="run-record-list flex flex-col">
            {entries.map(entry => {
              const { run, goal } = entry;
              const isExpanded = expanded === entry.key;
              const message = entry.message ?? (isExpanded ? detailMessage : undefined);
              const status = message?.parts.some(part => isToolPart(part) && part.state === "approval-requested") ? "waiting_approval" : run?.status;
              return (
              <li className="run-record-entry min-w-0 text-xs" key={entry.key}>
                <button
                  aria-expanded={isExpanded}
                  className="run-record-trigger flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-2 text-left"
                  onClick={() => setExpanded(current => current === entry.key ? null : entry.key)}
                  title={goal}
                  type="button"
                >
                  <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-[--dur-base]", isExpanded && "rotate-90")} />
                  {status ? <StatusIcon status={status} /> : <History aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate leading-5">{goal.replace(/\s+/g, " ")}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{status ? t(`chat.run.status.${status}`) : "详情"}</span>
                </button>
                <div className="run-detail" data-state={isExpanded ? "open" : "closed"} inert={!isExpanded} aria-hidden={!isExpanded}>
                  <div className="min-h-0 overflow-hidden">
                    <div className="flex min-w-0 flex-col gap-3 px-3 pb-3 pt-2">
                      {goal.length > 80 || goal.includes("\n") ? <p className="whitespace-pre-wrap break-words leading-5 text-muted-foreground" data-testid="run-full-goal">{goal}</p> : null}
                      {run?.stopReason ? <p className="text-warning">{`${t("chat.run.stopReason")}: ${run.stopReason}`}</p> : null}
                      {run?.status === "failed" || run?.status === "paused" ? <p className="text-muted-foreground">{executionGuidance(run.stopReason)}</p> : null}
                      {run && run.steps.length > 0 && !message?.parts.some(isToolPart) ? (
                        <ol className="flex flex-col gap-1.5">
                          {run.steps.map(step => (
                            <li className="flex min-w-0 flex-col gap-1" key={step.id}>
                              <div className="flex min-w-0 items-center gap-2">
                              <StepIcon state={step.state} />
                              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{String(step.position).padStart(2, "0")}</span>
                              <span className="min-w-0 flex-1 truncate">{step.toolName ?? step.kind}</span>
                              <span className="shrink-0 text-muted-foreground">{t(`runs.step.${step.state}`)}</span>
                              {step.errorCode ? <span title={executionGuidance(step.errorCode)} className="break-all text-destructive">{step.errorCode}</span> : null}
                              </div>
                              {step.input != null || step.output != null ? <details className="execution-disclosure pl-5"><summary><ChevronRight aria-hidden="true" />已保存的步骤摘要</summary><pre className="execution-code chat-list-scroll">{safeJson({ input: step.input, output: step.output })}</pre></details> : null}
                            </li>
                          ))}
                        </ol>
                      ) : null}
                      {isExpanded && message ? <ExecutionTurnDetails message={message} isLatest={messages.at(-1)?.id === message.id} onReviewApproval={() => setOpen(false)} /> : null}
                      {isExpanded && run && !message && detail?.key === entry.key && !detail.error ? <p role="status" className="text-muted-foreground">该记录未保存可关联的完整详情；上方仅展示已保存的步骤摘要。</p> : null}
                      {isExpanded && run && !message && detail?.key !== entry.key ? <p role="status" className="text-muted-foreground">正在读取详情…</p> : null}
                      {isExpanded && !message && detail?.key === entry.key && detail.error ? <p role="alert" className="text-destructive">{detail.error}</p> : null}
                      {run ? <details className="execution-disclosure text-muted-foreground">
                        <summary><ChevronRight aria-hidden="true" />调试信息</summary>
                        <div className="flex flex-col gap-2 pb-2 leading-5">
                          {entry.stages > 1 ? <p>当前列表合并了 {entry.stages} 个执行阶段，以下为最近阶段的限制。</p> : null}
                          <p>{`${t("chat.run.budget")}: ${run.budget.maxSteps} ${t("chat.run.steps")} / ${Math.round(run.budget.deadlineMs / 1000)}s / ${run.budget.maxFailures} ${t("runs.failures")}`}</p>
                          {run.status === "failed" || run.status === "paused" || run.status === "cancelled" ? <p>恢复前请核对已完成步骤。需要继续时，请重新发送请求；文件和工具写入仍需重新批准。</p> : null}
                          <a className="w-fit underline underline-offset-4" href="/api/diagnostics" download>导出脱敏诊断</a>
                        </div>
                      </details> : null}
                    </div>
                  </div>
                </div>
              </li>
              );
            })}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function StatusIcon({ status }: { status: RunView["status"] }) {
  if (status === "running")
    return (
      <Loader2
        aria-hidden="true"
        className="size-3.5 shrink-0 animate-spin"
      />
    );
  if (status === "succeeded")
    return (
      <CheckCircle2
        aria-hidden="true"
        className="size-3.5 shrink-0 text-success"
      />
    );
  return (
    <AlertCircle
      aria-hidden="true"
      className="size-3.5 shrink-0 text-warning"
    />
  );
}

function StepIcon({ state }: { state: string }) {
  if (state === "done")
    return (
      <CheckCircle2
        aria-hidden="true"
        className="size-3 shrink-0 text-success"
      />
    );
  if (state === "running" || state === "waiting_approval")
    return (
      <Loader2 aria-hidden="true" className="size-3 shrink-0 animate-spin" />
    );
  return (
    <AlertCircle
      aria-hidden="true"
      className="size-3 shrink-0 text-muted-foreground"
    />
  );
}
