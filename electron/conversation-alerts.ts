import type { Notification, NotificationConstructorOptions } from "electron";
import type { DesktopLogger } from "./logger";

/*
 * Telling the user an answer is ready while they are elsewhere.
 *
 * The service says when a turn ends in any conversation
 * (/api/conversations/events). When one the user started ends while the
 * window is not in front, a system notification says so; clicking it opens the
 * conversation. With the window in front the sidebar's dot is enough. A task's
 * turns are left to the task's own notifications, which the user set per task.
 */

export type TurnFinished = { chatId: string; outcome: "succeeded" | "failed" | "waiting_approval" | "stopped"; title: string | null };
type NotificationConstructor = new (options: NotificationConstructorOptions) => Notification;

const BODIES: Record<Exclude<TurnFinished["outcome"], "stopped">, { "zh-CN": string; "en-US": string }> = {
  succeeded: { "zh-CN": "回答好了", "en-US": "The answer is ready" },
  waiting_approval: { "zh-CN": "在等你批准", "en-US": "Waiting for your approval" },
  failed: { "zh-CN": "没能完成回答", "en-US": "The answer could not be finished" },
};

/** The page a notification about a conversation opens: that conversation, in chat. */
export function conversationPath(chatId: string) {
  return `/chat?conversationId=${encodeURIComponent(chatId)}`;
}

/** What a notification about an ended turn says, or null when it says nothing worth interrupting for. */
export function turnNotice(turn: TurnFinished, locale: "zh-CN" | "en-US") {
  if (turn.outcome === "stopped") return null;
  const untitled = locale === "en-US" ? "Conversation" : "会话";
  return { title: turn.title?.trim() || untitled, body: BODIES[turn.outcome]?.[locale] ?? BODIES.succeeded[locale] };
}

export function createConversationNotificationDelivery(NativeNotification: NotificationConstructor, open: (path: string) => void, logger: DesktopLogger, getLocale: () => "zh-CN" | "en-US", icon: () => { icon?: string } = () => ({})) {
  const active = new Set<Notification>();
  return (turn: TurnFinished) => {
    const notice = turnNotice(turn, getLocale());
    if (!notice) return;
    const notification = new NativeNotification({ ...icon(), title: notice.title, body: notice.body, silent: false });
    notification.once("click", () => open(conversationPath(turn.chatId)));
    notification.once("close", () => active.delete(notification));
    notification.once("failed", () => {
      active.delete(notification);
      logger.warn("Conversation notification was rejected by the operating system");
    });
    // Keep native objects alive for click handling, with a bounded history.
    if (active.size >= 30) {
      const oldest = active.values().next().value!;
      oldest.close();
      active.delete(oldest);
    }
    active.add(notification);
    notification.show();
  };
}

/** Reads one turn-finished event a turn's `data` line describes, or null when it is not one to notify about. */
export function readTurnFinished(data: string): TurnFinished | null {
  let event: { type?: unknown; chatId?: unknown; source?: unknown; outcome?: unknown; title?: unknown };
  try { event = JSON.parse(data); } catch { return null; }
  if (event.type !== "turn-finished" || event.source !== "chat") return null;
  if (typeof event.chatId !== "string" || event.chatId.length > 200) return null;
  if (!["succeeded", "failed", "waiting_approval", "stopped"].includes(String(event.outcome))) return null;
  const title = typeof event.title === "string" ? event.title.slice(0, 200) : null;
  return { chatId: event.chatId, outcome: event.outcome as TurnFinished["outcome"], title };
}

/** How long to wait before following again after the connection drops, growing while it keeps failing. */
const RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

export class ConversationAlerts {
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  constructor(private readonly options: {
    connection: () => { origin: string; cookie: string } | null;
    supported: () => boolean;
    /** Whether the window is in front, where the sidebar already shows it. */
    inFront: () => boolean;
    deliver: (turn: TurnFinished) => void;
    logger: DesktopLogger;
  }) {}

  start() {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.follow(controller.signal);
  }

  async stop() {
    this.controller?.abort();
    this.controller = null;
    await this.running?.catch(() => {});
    this.running = null;
  }

  private async follow(signal: AbortSignal) {
    let failures = 0;
    while (!signal.aborted) {
      const connection = this.options.connection();
      if (connection && this.options.supported()) {
        try {
          const response = await fetch(`${connection.origin}/api/conversations/events`, { headers: { Cookie: connection.cookie, Accept: "text/event-stream" }, redirect: "error", signal });
          if (!response.ok || !response.body) throw new Error("Conversation events unavailable");
          failures = 0;
          await this.read(response.body, signal);
        } catch {
          // No titles, cookies or bodies in logs.
          if (signal.aborted) return;
          if (failures === 0) this.options.logger.warn("Lost the conversation events; following them again shortly");
        }
      }
      const wait = RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)];
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, wait);
        timer.unref?.();
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }

  private async read(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    // Stopping ends the read at once, whatever the body would otherwise wait for.
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    let pending = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) return;
        pending += decoder.decode(value, { stream: true });
        const events = pending.split("\n\n");
        pending = events.pop() ?? "";
        for (const event of events) this.handle(event);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  }

  private handle(event: string) {
    const lines = event.split("\n");
    if (!lines.includes("event: turn")) return;
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    const turn = readTurnFinished(data);
    if (!turn || this.options.inFront()) return;
    try { this.options.deliver(turn); }
    catch { this.options.logger.warn("Unable to display a conversation notification"); }
  }
}
