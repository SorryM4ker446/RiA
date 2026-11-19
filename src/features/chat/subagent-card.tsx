"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Bot, ChevronRight } from "lucide-react";
import { useLocale } from "@/lib/locale/client";
import { t, tf } from "@/lib/locale";
import { useConversationStore, type SubagentNotice } from "@/features/chat/conversation-store";
import { subagentNoticeText } from "@/lib/chat/subagent-notice";

/*
 * The conversation's sub-agents as cards in the answer that started them: the
 * title, whether it runs in the background, how long it has run and what it is
 * doing now, a stop of its own, and its report once it ends. Foreground and
 * background ones look the same; only the label differs.
 *
 * The list is read once for the conversation and kept current from the
 * service's events; an ended one is read again for its report.
 */

type Status = SubagentNotice["status"];
export type SubagentView = {
  id: string; runId: string | null; toolCallId: string; title: string; background: boolean; status: Status; startedAt: string; finishedAt: string | null;
  currentStep: string | null; toolCalls: number; report: string | null; notRun: Array<{ tool: string }>; error: string | null;
};

/** Records by the call that started them; a provider may give two turns' calls the same id, so the run tells them apart. */
const SubagentsContext = createContext<{ byCall: Map<string, SubagentView[]>; stop: (id: string) => Promise<void> } | null>(null);

/** `enabled`: the conversation shown has a sub-agent call; one without any reads nothing. */
export function SubagentsProvider({ chatId, enabled, children }: { chatId: string | null; enabled: boolean; children: ReactNode }) {
  const { onSubagent } = useConversationStore();
  // Kept with the conversation it was read for, so another conversation never shows this one's cards.
  const [read, setRead] = useState<{ chatId: string | null; views: SubagentView[] }>({ chatId: null, views: [] });
  const views = useMemo(() => read.chatId === chatId ? read.views : [], [read, chatId]);
  // Read when the conversation opens, and again whenever an event says something the list does not hold yet.
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!chatId || !enabled) return;
    let current = true;
    void (async () => {
      const response = await fetch(`/api/conversations/${chatId}/subagents`, { cache: "no-store" }).catch(() => null);
      const body = response?.ok ? await response.json().catch(() => null) as { data?: SubagentView[] } | null : null;
      if (current && body?.data) setRead({ chatId, views: body.data });
    })();
    return () => { current = false; };
  }, [chatId, enabled, version]);
  useEffect(() => onSubagent(notice => {
    if (notice.chatId !== chatId) return;
    // A new one, or one that ended, is read again for what the event does not carry: its title, report.
    const known = views.some(view => view.id === notice.id);
    if (known) setRead(current => current.chatId !== chatId ? current : { chatId, views: current.views.map(view => view.id === notice.id ? { ...view, status: notice.status, currentStep: notice.currentStep } : view) });
    if (!known || notice.status !== "running") setVersion(value => value + 1);
  }), [chatId, onSubagent, views]);
  const stop = useCallback(async (id: string) => {
    if (!chatId) return;
    await fetch(`/api/conversations/${chatId}/subagents/${id}/stop`, { method: "POST" }).catch(() => null);
  }, [chatId]);
  const value = useMemo(() => {
    const byCall = new Map<string, SubagentView[]>();
    for (const view of views) byCall.set(view.toolCallId, [...byCall.get(view.toolCallId) ?? [], view]);
    return { byCall, stop };
  }, [views, stop]);
  return <SubagentsContext.Provider value={value}>{children}</SubagentsContext.Provider>;
}

/** Whole seconds since a moment, ticking while `running`. */
function useSeconds(since: string | null, until: string | null, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!since) return 0;
  return Math.max(0, Math.round(((until ? Date.parse(until) : now) - Date.parse(since)) / 1000));
}

type CallPart = { toolCallId: string; state: string; input?: unknown; output?: unknown };

export function SubagentCard({ part, runIds, toolName }: { part: CallPart; runIds: readonly string[]; toolName: (id: string) => string | null }) {
  useLocale();
  const context = useContext(SubagentsContext);
  // The one of this answer's run; while the answer does not know its run yet, the newest with this call's id.
  const matches = context?.byCall.get(part.toolCallId) ?? [];
  const view = matches.find(item => item.runId && runIds.includes(item.runId)) ?? (runIds.length ? null : matches.at(-1)) ?? null;
  const input = (part.input ?? {}) as { title?: unknown; background?: unknown };
  const output = (part.output ?? null) as { status?: unknown; report?: unknown; error?: unknown; background?: unknown } | null;
  const title = view?.title ?? (typeof input.title === "string" ? input.title : t("chat.subagent.untitled"));
  const background = view?.background ?? input.background === true;
  // The record knows best; before it is read, the call itself says whether it is still going.
  const status: Status = view?.status ?? (part.state === "output-available" && typeof output?.status === "string" && output.status !== "running" ? output.status as Status
    : part.state === "output-error" ? "failed" : "running");
  const running = status === "running";
  const seconds = useSeconds(view?.startedAt ?? null, view?.finishedAt ?? null, running);
  const report = view?.report ?? (typeof output?.report === "string" ? output.report : null);
  const error = view?.error ?? (typeof output?.error === "string" ? output.error : null);
  const step = view?.currentStep ? toolName(view.currentStep) ?? view.currentStep : null;
  const [stopping, setStopping] = useState(false);
  const state = running
    ? [seconds ? tf("chat.subagent.runningFor", { seconds }) : t("chat.subagent.starting"), step ? tf("chat.subagent.step", { tool: step }) : null].filter(Boolean).join(" · ")
    : status === "done" ? (seconds ? tf("chat.subagent.doneIn", { seconds }) : t("chat.subagent.done"))
    : t(status === "failed" ? "chat.subagent.failed" : status === "stopped" ? "chat.subagent.stopped" : "chat.subagent.interrupted");

  return <div className="subagent-card" data-status={status} role="group" aria-label={tf("chat.subagent.label", { title })}>
    <div className="subagent-card-head">
      <Bot aria-hidden="true" className="subagent-card-icon" />
      <span className="subagent-card-title">{title}</span>
      {background ? <span className="subagent-card-tag">{t("chat.subagent.background")}</span> : null}
      <span className={running ? "subagent-card-state thinking-live" : "subagent-card-state"} role={running ? "status" : undefined}>{state}</span>
      {running && view ? <button type="button" className="subagent-card-stop" disabled={stopping} aria-label={tf("chat.subagent.stop", { title })}
        onClick={() => { setStopping(true); void context?.stop(view.id); }}>{t(stopping ? "chat.subagent.stopping" : "chat.subagent.stopShort")}</button> : null}
    </div>
    {!running && (report || error) ? <details className="subagent-card-report">
      <summary><ChevronRight aria-hidden="true" />{t(report ? "chat.subagent.report" : "chat.subagent.error")}{view?.notRun.length ? ` · ${tf("chat.subagent.notRun", { count: view.notRun.length })}` : ""}</summary>
      <p className="whitespace-pre-wrap">{report ?? error}</p>
    </details> : null}
  </div>;
}

/** An automatic notice RiA sent itself, shown as a line between the turns rather than as the user's message. */
export function SubagentNoticeLine({ titles }: { titles: string[] }) {
  useLocale();
  return <p className="subagent-notice" role="note">{subagentNoticeText(titles)}</p>;
}
