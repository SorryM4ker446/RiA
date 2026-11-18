"use client";
import { useLocale } from "@/lib/locale/client";
import { t, tf } from "@/lib/locale";
import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { Reveal } from "@/components/ui/reveal";
import { latestPlan, type PlanItem } from "@/tools/definitions/update-plan";
import type { UIMessage } from "ai";
import type { ChatState } from "./use-chat-state";

const planId = (messageId: string) => `task-plan-${messageId}`;

function Mark({ status }: { status: PlanItem["status"] }) {
  return <span className="task-plan-mark" data-status={status} aria-hidden="true">{status === "completed" ? <Check strokeWidth={3} /> : null}</span>;
}

/**
 * The checklist to show for an answer: while it works through its steps, and
 * no longer once the final answer starts (text after the last tool call) or
 * the turn has ended, as in Claude Code. The calls stay in the execution
 * record; the conversation keeps only the answer.
 */
export function shownPlan(message: UIMessage | undefined, live: boolean): PlanItem[] | null {
  if (!live || message?.role !== "assistant") return null;
  let lastTool = -1;
  message.parts.forEach((part, index) => { if (part.type.startsWith("tool-") || part.type === "dynamic-tool") lastTool = index; });
  const answering = message.parts.some((part, index) => index > lastTool && part.type === "text" && part.text.trim().length > 0);
  return answering ? null : latestPlan(message.parts);
}

/**
 * The checklist the model keeps for a task of several steps, in the answer
 * where it first wrote it. Each update redraws the same card; it can be folded
 * to one line while it runs.
 */
export function TaskPlan({ messageId, items }: { messageId: string; items: PlanItem[] }) {
  useLocale();
  const [open, setOpen] = useState(true);
  const done = items.filter(item => item.status === "completed").length;
  return <section id={planId(messageId)} className="task-plan" data-live="" aria-label={t("chat.plan.title")}>
    <button type="button" className="task-plan-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="task-plan-title">{t("chat.plan.title")}</span>
      <span className="task-plan-count">{tf("chat.plan.progress", { done, total: items.length })}</span>
      <ChevronDown aria-hidden="true" className={cn("task-plan-chevron", open && "rotate-180")} />
    </button>
    <span className="task-plan-bar" aria-hidden="true"><span style={{ width: `${(done / items.length) * 100}%` }} /></span>
    <div className="reveal" data-state={open ? "open" : "closed"} aria-hidden={!open || undefined} inert={!open}>
      <div className="min-h-0 overflow-hidden">
        <ol className="task-plan-list">
          {items.map((item, index) => <li key={`${index}:${item.content}`} className="task-plan-item" data-status={item.status}>
            <Mark status={item.status} />
            <span className={cn("task-plan-text", item.status === "in_progress" && "thinking-live")}>{item.content}</span>
            <span className="sr-only">{t(`chat.plan.status.${item.status}`)}</span>
          </li>)}
        </ol>
      </div>
    </div>
  </section>;
}

/**
 * While an answer runs, the step it is on, just above the composer, so the
 * progress is in view without scrolling back. A click goes to the checklist.
 */
export function PlanStrip({ messages, isPending }: Pick<ChatState, "messages" | "isPending">) {
  useLocale();
  const last = messages.at(-1);
  const items = shownPlan(last, isPending);
  const current = items?.find(item => item.status === "in_progress");
  // Folds in and out like the card, rather than appearing and vanishing.
  return <Reveal>{last && items && current ? <button type="button" className="plan-strip" onClick={() => document.getElementById(planId(last.id))?.scrollIntoView({ behavior: "smooth", block: "center" })}>
    <Mark status="in_progress" />
    <span className="min-w-0 truncate">{tf("chat.plan.now", { step: current.content })}</span>
    <span className="plan-strip-count">{items.indexOf(current) + 1}/{items.length}</span>
  </button> : null}</Reveal>;
}
