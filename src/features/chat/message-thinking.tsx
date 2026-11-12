"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useLocale } from "@/lib/locale/client";
import { t, tf } from "@/lib/locale";
import type { readThinking } from "@/lib/chat/thinking";
import type { TurnNotice } from "./page-utils";

type Thinking = NonNullable<ReturnType<typeof readThinking>>;

/** Whole seconds only once there is a second to speak of. */
const seconds = (ms: number | undefined) => (ms !== undefined && ms >= 1000 ? Math.round(ms / 1000) : null);

/** Time spent while `running`, across pauses such as waiting on a tool. Only for display. */
function useElapsed(running: boolean) {
  const [elapsed, setElapsed] = useState(0);
  const banked = useRef(0);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = window.setInterval(() => setElapsed(banked.current + Date.now() - started), 1000);
    return () => {
      window.clearInterval(timer);
      banked.current += Date.now() - started;
      setElapsed(banked.current);
    };
  }, [running]);
  return elapsed;
}

/** A motion token in milliseconds. The production build rewrites them, so 360ms is served as .36s. */
function tokenMs(name: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return (parseFloat(value) || 0) * (value.endsWith("ms") ? 1 : 1000);
}

/**
 * Opens or folds the disclosure in whole pixels. The answer below is pinned to the
 * bottom of a scroll position that only takes whole pixels, so a height eased in
 * fractions, as a CSS transition does, makes the text shake by a pixel every frame.
 */
export function useDisclosureMotion() {
  const frame = useRef<number | null>(null);
  const shown = useRef<number | null>(null);
  const settle = useCallback((node: HTMLDetailsElement, open: boolean) => {
    frame.current = null; shown.current = null;
    node.open = open;
    node.style.removeProperty("--fold-block");
    delete node.dataset.folding;
  }, []);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  return useCallback((node: HTMLDetailsElement, open: boolean) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { settle(node, open); return; }
    const from = shown.current ?? (node.open ? null : 0);
    // The body's full height, read with nothing holding it back.
    node.open = true;
    node.style.removeProperty("--fold-block");
    const full = Math.round(node.getBoundingClientRect().height - node.querySelector("summary")!.getBoundingClientRect().height - parseFloat(getComputedStyle(node).paddingBottom));
    const start = from ?? full, end = open ? full : 0;
    node.style.setProperty("--fold-block", `${start}px`);
    node.dataset.folding = open ? "opening" : "closing";
    const duration = tokenMs("--dur-slow");
    const began = performance.now();
    const step = (now: number) => {
      const progress = duration ? Math.min(1, (now - began) / duration) : 1;
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
      const height = Math.round(start + (end - start) * eased);
      if (height !== shown.current) { shown.current = height; node.style.setProperty("--fold-block", `${height}px`); }
      if (progress < 1) frame.current = requestAnimationFrame(step);
      else settle(node, open);
    };
    frame.current = requestAnimationFrame(step);
  }, [settle]);
}

/**
 * The model's reasoning, above its answer. It is open while the model reasons and
 * folds when the answer starts, so the eye lands on the answer; opening or closing
 * it by hand holds until the next of those moments. A turn whose provider returned
 * no text says it reasoned, and offers nothing to open.
 */
export function MessageThinking({ thinking, live, reasoning, answering, toolName }: {
  thinking: Thinking;
  /** The turn is still running, including while it waits for an approval. */
  live: boolean;
  /** Reasoning text is arriving now. */
  reasoning: boolean;
  /** The answer has started since the latest reasoning. */
  answering: boolean;
  toolName: (id: string) => string | null;
}) {
  useLocale();
  const disclosure = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const open = reasoning || (live && !answering);
  const elapsed = useElapsed(reasoning);
  const moveDisclosure = useDisclosureMotion();
  const placed = useRef(false);
  useLayoutEffect(() => {
    const node = disclosure.current;
    if (!node) return;
    // A reply already in view opens where it stands; only a change after that moves.
    if (placed.current) moveDisclosure(node, open); else node.open = open;
    placed.current = true;
  }, [open, moveDisclosure]);
  // Keeps the newest reasoning in view, unless the reader scrolled back through it.
  useLayoutEffect(() => {
    const node = body.current;
    if (node && live && following.current) node.scrollTop = node.scrollHeight;
  }, [thinking.text.length, live]);

  const taken = seconds(thinking.durationMs ?? elapsed);
  if (thinking.kind === "hidden") return <p className="message-reasoning-static">
    {taken ? tf("chat.thinking.hiddenDone", { seconds: taken }) : t("chat.thinking.hiddenDoneShort")}
    <span className="message-reasoning-note">{t("chat.thinking.hiddenNote")}</span>
  </p>;
  const summary = thinking.kind === "summary";
  const title = reasoning
    ? (taken ? tf("chat.thinking.liveTime", { seconds: taken }) : t("chat.messages.reasoningLive"))
    : summary
      ? (taken ? tf("chat.thinking.summaryDone", { seconds: taken }) : t("chat.thinking.summary"))
      : (taken ? tf("chat.thinking.done", { seconds: taken }) : t("chat.messages.reasoningTitle"));
  return <details ref={disclosure} className="message-reasoning" data-live={live || undefined}>
    <summary className="message-reasoning-summary" onClick={event => { event.preventDefault(); const node = disclosure.current!; moveDisclosure(node, node.dataset.folding ? node.dataset.folding === "closing" : !node.open); }}>
      <ChevronRight aria-hidden="true" className="reasoning-chevron" />
      <span className={reasoning ? "thinking-live" : undefined}>{title}</span>
    </summary>
    <div ref={body} className="message-reasoning-body" onScroll={event => { const node = event.currentTarget; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24; }}>
      {thinking.segments.map((segment, index) => {
        const tools = segment.tools.flatMap(id => toolName(id) ?? []);
        return <div key={index}>
          {segment.text ? <p className="whitespace-pre-wrap">{segment.text}</p> : null}
          {tools.length ? <p className="message-reasoning-step">{tf("chat.thinking.usedTools", { tools: tools.join(t("chat.composer.attachmentSeparator")) })}</p> : null}
        </div>;
      })}
    </div>
  </details>;
}

/** Between sending and the first thing the model returns: waiting for a place, a retry, or the model itself. */
export function ReplyPending({ reasoning, organizing = false, notice = null }: { reasoning: boolean; organizing?: boolean; notice?: TurnNotice | null }) {
  useLocale();
  const text = notice?.state === "queued" ? (notice.ahead > 0 ? tf("chat.thinking.queued", { ahead: notice.ahead }) : t("chat.thinking.queuedNext"))
    : notice?.state === "retrying" ? tf("chat.thinking.retrying", { seconds: notice.seconds, attempt: notice.attempt })
    : organizing ? t("chat.thinking.organizing") : reasoning ? t("chat.messages.reasoningLive") : t("chat.thinking.replying");
  return <p className="reply-pending" role="status"><span className="thinking-live">{text}</span></p>;
}
