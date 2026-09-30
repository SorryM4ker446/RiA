"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ChevronRight, Loader2, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getApiErrorMessage } from "@/lib/api-error-message";
import { t, tf } from "@/lib/locale";
import { cn } from "@/lib/utils/cn";
import type { RunView } from "@/lib/agent/runs";

type Props = {
  activeChatId: string | null;
  /** Bumped by the caller when a turn finishes, so the list refreshes with it. */
  refreshKey?: number;
};

/**
 * What a turn actually did.
 *
 * Shown rather than hidden because the alternative is trusting that a tool ran
 * because the answer says so. The states are the ones that can be acted on:
 * something is running, something is waiting, something was skipped, or the run
 * stopped on purpose.
 */
export function RunRecords({ activeChatId, refreshKey }: Props) {
  const [runs, setRuns] = useState<RunView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  // A runs request outlives the conversation it was asked for, so every load
  // takes a number and only the newest one is allowed to write. Without it,
  // switching conversations mid-request showed the previous conversation's runs
  // under the new one, and a failure left its message on screen for good.
  const runsRequestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++runsRequestRef.current;
    if (!activeChatId) {
      setRuns([]);
      setError(null);
      return;
    }
    try {
      const response = await fetch(`/api/conversations/${activeChatId}/runs?limit=10`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(getApiErrorMessage(payload, t("runs.error.load")));
      if (requestId !== runsRequestRef.current) return;
      setRuns(Array.isArray(payload.data) ? payload.data : []);
      // The list is what this panel reports, so a message from an earlier
      // request has nothing left to say once a newer one has answered.
      setError(null);
    } catch (loadError) {
      if (requestId !== runsRequestRef.current) return;
      setError(loadError instanceof Error ? loadError.message : t("runs.error.load"));
    }
  }, [activeChatId]);

  useEffect(() => {
    void load();
    return () => { runsRequestRef.current += 1; };
  }, [load, refreshKey]);

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
      if (!response.ok) throw new Error(getApiErrorMessage(payload, t("runs.error.stop")));
      setExpanded(null);
      await load();
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : t("runs.error.stop"));
    } finally {
      setIsStopping(false);
    }
  }

  if (!activeChatId) return null;
  const running = runs.find((run) => run.status === "running" || run.status === "waiting_approval");

  return (
    <section aria-label={t("runs.title")} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-label">{t("runs.title")}</h2>
        {running ? (
          <Button disabled={isStopping} onClick={() => void stop()} size="sm" type="button" variant="outline">
            {isStopping ? <Loader2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Square aria-hidden="true" className="mr-1.5 h-3 w-3 fill-current" />}
            {t("chat.run.stop")}
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {runs.length === 0 ? <p className="text-xs text-muted-foreground">{t("chat.run.empty")}</p> : null}
      <ul className="space-y-1.5">
        {runs.map((run) => (
          <li className="rounded-md bg-muted/60 text-xs" key={run.id}>
            <button
              aria-expanded={expanded === run.id}
              className="flex w-full items-center gap-2 px-3 py-2 text-left"
              onClick={() => setExpanded((current) => (current === run.id ? null : run.id))}
              type="button"
            >
              <ChevronRight aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0 transition-transform", expanded === run.id && "rotate-90")} />
              <StatusIcon status={run.status} />
              <span className="min-w-0 flex-1 truncate">{run.goal}</span>
              <Badge variant="outline">{t(`chat.run.status.${run.status}`)}</Badge>
            </button>
            {expanded === run.id ? (
              <div className="space-y-1 border-t px-3 py-2">
                <p className="text-muted-foreground">
                  {`${t("chat.run.budget")}: ${run.budget.maxSteps} ${t("chat.run.steps")} / ${Math.round(run.budget.deadlineMs / 1000)}s / ${run.budget.maxFailures} ${t("runs.failures")}`}
                </p>
                {run.stopReason ? <p className="text-warning">{`${t("chat.run.stopReason")}: ${run.stopReason}`}</p> : null}
                <ol className="space-y-1">
                  {run.steps.map((step) => (
                    <li className="flex items-center gap-2" key={step.id}>
                      <StepIcon state={step.state} />
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{String(step.position).padStart(2, "0")}</span>
                      <span className="min-w-0 flex-1 truncate">{step.toolName ?? step.kind}</span>
                      <span className="shrink-0 text-muted-foreground">{t(`runs.step.${step.state}`)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusIcon({ status }: { status: RunView["status"] }) {
  if (status === "running") return <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin" />;
  if (status === "succeeded") return <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-success" />;
  return <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-warning" />;
}

function StepIcon({ state }: { state: string }) {
  if (state === "done") return <CheckCircle2 aria-hidden="true" className="h-3 w-3 shrink-0 text-success" />;
  if (state === "running" || state === "waiting_approval") return <Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin" />;
  return <AlertCircle aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />;
}
