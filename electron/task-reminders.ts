import type { Notification, NotificationConstructorOptions } from "electron";
import type { DesktopLogger } from "./logger";

export type TaskReminder = { id: string; title: string; dueDate: string; timeZone: string };
type NotificationConstructor = new (options: NotificationConstructorOptions) => Notification;

export function createTaskNotificationDelivery(NativeNotification: NotificationConstructor, focus: () => void, logger: DesktopLogger) {
  const active = new Set<Notification>();
  return (task: TaskReminder) => {
    const due = new Date(task.dueDate).toLocaleString("zh-CN", { timeZone: task.timeZone });
    const notification = new NativeNotification({ title: task.title, body: `任务已到期：${due}（${task.timeZone}）`, silent: false });
    notification.once("click", focus);
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

function parseReminders(payload: unknown): TaskReminder[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length > 10) throw new Error("Invalid task reminder response");
  return data.map(task => {
    if (!task || typeof task.id !== "string" || task.id.length > 100 || typeof task.title !== "string" || task.title.length > 120 ||
        typeof task.dueDate !== "string" || !Number.isFinite(Date.parse(task.dueDate)) || typeof task.timeZone !== "string" || task.timeZone.length > 100) {
      throw new Error("Invalid task reminder response");
    }
    new Intl.DateTimeFormat("en", { timeZone: task.timeZone });
    return { id: task.id, title: task.title, dueDate: task.dueDate, timeZone: task.timeZone };
  });
}

export class TaskReminderPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  constructor(private readonly options: {
    connection: () => { origin: string; cookie: string } | null;
    supported: () => boolean;
    deliver: (task: TaskReminder) => void;
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
        const response = await fetch(`${connection.origin}/api/tasks/reminders`, {
          method: "POST", headers: { Cookie: connection.cookie }, redirect: "error", signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error("Task reminder check failed");
        const tasks = parseReminders(await response.json());
        for (const task of tasks) {
          try { this.options.deliver(task); }
          catch { this.options.logger.warn("Unable to display a task notification"); }
        }
      } catch {
        // No task titles, cookies, response bodies or credentials in logs.
        this.options.logger.warn("Unable to check task reminders; will check again on the next interval");
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
