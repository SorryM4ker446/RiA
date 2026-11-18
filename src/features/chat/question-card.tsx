"use client";
import { useLocale } from "@/lib/locale/client";
import { t, tf, localizeMessage } from "@/lib/locale";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils/cn";
import { askUserInput, ASK_LIMITS, type AskUserInput, type AskUserOutput } from "@/tools/definitions/ask-user";
import { isToolPart, type ToolPart } from "./page-utils";
import type { ChatState } from "./use-chat-state";

/** Told to the model when the user skips, in its language: it decides for itself and says what it assumed. */
export const SKIPPED_REASON = "The user skipped the question. Decide yourself, and say briefly what you assumed.";

/** The question waiting in the last answer, if there is one. */
export function pendingQuestion(messages: UIMessage[]): { part: ToolPart; input: AskUserInput; approvalId: string } | null {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return null;
  for (const part of last.parts.filter(isToolPart)) {
    if (part.type !== "tool-askUser" || part.state !== "approval-requested" || !("approval" in part) || !part.approval) continue;
    const input = askUserInput.safeParse(part.input);
    if (input.success) return { part, input: input.data, approvalId: part.approval.id };
  }
  return null;
}

/** An answer typed in the message box instead: the same words for every question. */
export function typedAnswer(input: AskUserInput, text: string) {
  return JSON.stringify({ answers: input.questions.map(() => ({ selected: [], other: text.slice(0, ASK_LIMITS.other) })) });
}

type Answer = { selected: string[]; other: string; otherOpen: boolean };
const answered = (answer: Answer) => answer.selected.length > 0 || answer.other.trim().length > 0;

/**
 * A question the model asked, where approvals appear. Options are whole rows:
 * a single choice is a radio row, several are checkbox rows, and "Other"
 * opens a line to answer in your own words. One question with one choice is
 * answered by choosing; otherwise the button goes on to the next question and
 * then sends. Skip lets the model decide. ↑↓ move between rows, a number picks.
 */
export function QuestionCard({ part, input, approvalId, count, disabled, respond }: {
  part: ToolPart; input: AskUserInput; approvalId: string; count: number; disabled: boolean; respond: ChatState["addToolApprovalResponse"];
}) {
  useLocale();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answer[]>(() => input.questions.map(() => ({ selected: [], other: "", otherOpen: false })));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const otherId = useId();
  const question = input.questions[step];
  const answer = answers[step];
  const last = step === input.questions.length - 1;
  // One question, one choice: choosing is answering.
  const instant = input.questions.length === 1 && !question.multiSelect;

  async function send(next: Answer[]) {
    if (sending) return;
    setSending(true); setError(null);
    try {
      await respond({ id: approvalId, approved: true, reason: JSON.stringify({ answers: next.map(item => ({ selected: item.selected, ...(item.other.trim() ? { other: item.other.trim() } : {}) })) }) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("chat.ask.failed")); setSending(false); }
  }
  async function skip() {
    if (sending) return;
    setSending(true); setError(null);
    try { await respond({ id: approvalId, approved: false, reason: SKIPPED_REASON }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("chat.ask.failed")); setSending(false); }
  }
  function update(change: Partial<Answer>) {
    const next = answers.map((item, index) => index === step ? { ...item, ...change } : item);
    setAnswers(next);
    return next;
  }
  function choose(label: string) {
    if (disabled || sending) return;
    if (question.multiSelect) { update({ selected: answer.selected.includes(label) ? answer.selected.filter(item => item !== label) : [...answer.selected, label] }); return; }
    const next = update({ selected: [label], other: "", otherOpen: false });
    if (instant) void send(next);
  }
  function proceed() {
    if (!answered(answer)) return;
    if (last) void send(answers); else setStep(step + 1);
  }
  /** ↑↓ between rows, a number for that option. */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-ask-option]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[(at + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
    } else if (/^[1-9]$/.test(event.key) && Number(event.key) <= question.options.length) {
      event.preventDefault();
      choose(question.options[Number(event.key) - 1].label);
    }
  }

  // Options open the way to answer in your own words in place, as one more row.
  const footer = !instant || answer.otherOpen || step > 0;
  return <section id="chat-approval-card" className="question-card mx-auto w-full max-w-[42rem] shrink-0" role="region" aria-label={t("chat.ask.region")} tabIndex={-1}>
    <header className="question-head">
      {question.header ? <span className="question-chip">{question.header}</span> : null}
      <h3 className="question-text" id={`${otherId}-question`}>{question.question}</h3>
      {input.questions.length > 1 ? <span className="question-step">{step + 1}/{input.questions.length}</span> : null}
      {count > 1 ? <span className="question-step">{tf("ui.chat.approval-dock.more", { count: count - 1 })}</span> : null}
      <button type="button" className="question-skip" disabled={disabled || sending} onClick={() => void skip()}>{t("chat.ask.skip")}</button>
    </header>
    <div ref={listRef} className="question-options" role={question.multiSelect ? "group" : "radiogroup"} aria-labelledby={`${otherId}-question`} onKeyDown={onKeyDown}>
      {question.options.map((option, index) => {
        const on = answer.selected.includes(option.label);
        return <button key={option.label} type="button" data-ask-option="" className="question-option" data-on={on || undefined}
          role={question.multiSelect ? "checkbox" : "radio"} aria-checked={on} disabled={disabled || sending} onClick={() => choose(option.label)}>
          <span className="question-mark" data-kind={question.multiSelect ? "check" : "radio"} aria-hidden="true">{on && question.multiSelect ? <Check strokeWidth={3} /> : null}</span>
          <span className="question-label">{option.label}</span>
          {option.description ? <span className="question-hint" title={option.description}>{option.description}</span> : null}
          <kbd className="question-key" aria-hidden="true">{index + 1}</kbd>
        </button>;
      })}
      {answer.otherOpen
        ? <label className="question-option question-other-row" data-on="">
          <span className="question-mark" data-kind="other" aria-hidden="true" />
          {/* Opened by a click, so it takes the focus the click gave. */}
          <input id={otherId} className="question-other" autoFocus value={answer.other} maxLength={ASK_LIMITS.other} placeholder={t("chat.ask.otherPlaceholder")}
            aria-label={t("chat.ask.other")} onChange={event => update({ other: event.target.value })}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); proceed(); }
              if (event.key === "Escape" && !answer.other) { event.preventDefault(); update({ otherOpen: false }); }
            }} />
        </label>
        : <button type="button" data-ask-option="" className="question-option" disabled={disabled || sending}
          onClick={() => update({ otherOpen: true, ...(question.multiSelect ? {} : { selected: [] }) })}>
          <span className="question-mark" data-kind="other" aria-hidden="true" />
          <span className="question-label text-muted-foreground">{t("chat.ask.other")}</span>
        </button>}
    </div>
    {error ? <p role="alert" className="px-2 pt-1 text-xs text-destructive">{localizeMessage(error)}</p> : null}
    {footer ? <footer className="question-foot">
      {step > 0 ? <Button type="button" size="sm" variant="ghost" className="h-7 px-2.5 text-xs" disabled={sending} onClick={() => setStep(step - 1)}>{t("chat.ask.back")}</Button> : null}
      <Button type="button" size="sm" className="ml-auto h-7 px-3 text-xs" disabled={disabled || sending || !answered(answer)} onClick={proceed}>
        {sending ? <Spinner data-icon="inline-start" /> : null}{last ? t("chat.ask.submit") : t("chat.ask.next")}
      </Button>
    </footer> : sending ? <Spinner className="mx-auto my-1" /> : null}
  </section>;
}

/**
 * What was asked and answered, kept in the answer once the question is done,
 * so the conversation still shows what was chosen.
 */
export function QuestionRecords({ parts }: { parts: readonly ToolPart[] }) {
  useLocale();
  const asked = parts.filter(part => part.type === "tool-askUser" && part.state !== "approval-requested" && part.state !== "input-streaming");
  if (!asked.length) return null;
  return <div className="question-records">
    {asked.map(part => {
      const input = askUserInput.safeParse(part.input);
      if (!input.success) return null;
      const output = part.state === "output-available" ? part.output as AskUserOutput | undefined : undefined;
      const skipped = part.state === "output-denied" || ("approval" in part && part.approval?.approved === false);
      return input.data.questions.map((question, index) => {
        const given = output?.answers[index];
        const reply = given ? [...given.selected, ...(given.other ? [given.other] : [])].join(t("chat.composer.attachmentSeparator")) : null;
        return <p key={`${part.toolCallId}:${index}`} className="question-record">
          <span className="question-record-q">{question.question}</span>
          <span className={cn("question-record-a", !reply && "text-muted-foreground")}>{reply ?? (skipped ? t("chat.ask.skipped") : t("chat.ask.waiting"))}</span>
        </p>;
      });
    })}
  </div>;
}
