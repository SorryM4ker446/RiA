import type { Notification, NotificationConstructorOptions } from "electron";
import type { DesktopLogger } from "./logger";

/** Something a task wants the user to know: `title` names what happened, `detail` names the task. */
export type TaskNotice = { id: string; title: string; detail: string | null; href: string | null };
type NotificationConstructor = new (options: NotificationConstructorOptions) => Notification;

const TITLES: Record<string, { "zh-CN": string; "en-US": string }> = {
  "task-finished": { "zh-CN": "任务已完成", "en-US": "Task finished" },
  "task-failed": { "zh-CN": "任务运行失败", "en-US": "Task failed" },
  "task-needs-approval": { "zh-CN": "任务在等你批准", "en-US": "A task needs your approval" },
  "task-skipped": { "zh-CN": "任务已跳过", "en-US": "Task skipped" },
  "task-missed": { "zh-CN": "任务错过了时间", "en-US": "A task missed its time" },
};

/**
 * Where a notice may take the window: a path inside the app, never another
 * origin, a protocol or a path that climbs out of it.
 */
export function inAppPath(href: string | null): string | null {
  if (!href || !href.startsWith("/") || href.startsWith("//") || href.includes("\\") || href.length > 2000) return null;
  try { return new URL(href, "http://app.invalid").origin === "http://app.invalid" ? href : null; } catch { return null; }
}

export function createTaskNotificationDelivery(NativeNotification: NotificationConstructor, open: (path: string | null) => void, logger: DesktopLogger, getLocale: () => "zh-CN" | "en-US" = () => "zh-CN", icon: () => { icon?: string } = () => ({})) {
  const active = new Set<Notification>();
  return (notice: TaskNotice) => {
    const locale = getLocale();
    // A kind this version does not know still says a task has something to show.
    const title = TITLES[notice.title]?.[locale] ?? (locale === "en-US" ? "Task update" : "任务有新动态");
    const notification = new NativeNotification({ ...icon(), title, body: notice.detail ?? "", silent: false });
    // A click brings the window forward on the task's conversation.
    notification.once("click", () => open(inAppPath(notice.href)));
    notification.once("close", () => active.delete(notification));
    notification.once("failed", () => {
      active.delete(notification);
      logger.warn("Task notification was rejected by the operating system");
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

function parseNotices(payload: unknown): TaskNotice[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length > 10) throw new Error("Invalid task notification response");
  return data.map(notice => {
    const text = (value: unknown, limit: number) => value === null || (typeof value === "string" && value.length <= limit);
    if (!notice || typeof notice.id !== "string" || notice.id.length > 100 || typeof notice.title !== "string" || notice.title.length > 200 ||
        !text(notice.detail, 2000) || !text(notice.href, 2000)) {
      throw new Error("Invalid task notification response");
    }
    return { id: notice.id, title: notice.title, detail: notice.detail, href: notice.href };
  });
}

export class TaskReminderPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  constructor(private readonly options: {
    connection: () => { origin: string; cookie: string } | null;
    supported: () => boolean;
    deliver: (notice: TaskNotice) => void;
    logger: DesktopLogger;
  }) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, 30_000);
    this.timer.unref();
    void this.poll();
  }

  poll(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.timer || !this.options.supported()) return Promise.resolve();
    const connection = this.options.connection();
    if (!connection) return Promise.resolve();
    this.inFlight = (async () => {
      try {
        const response = await fetch(`${connection.origin}/api/tasks/notifications`, {
          method: "POST", headers: { Cookie: connection.cookie }, redirect: "error", signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("Task notification check failed");
        const notices = parseNotices(await response.json());
        for (const notice of notices) {
          try { this.options.deliver(notice); }
          catch { this.options.logger.warn("Unable to display a task notification"); }
        }
      } catch {
        // No task titles, cookies, response bodies or credentials in logs.
        this.options.logger.warn("Unable to check task notifications; will check again on the next interval");
      }
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight;
  }
}
