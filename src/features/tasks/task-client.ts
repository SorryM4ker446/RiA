import { formatDateTime, getLocale, t, tf } from "@/lib/locale";
import { presetOfCron } from "@/lib/scheduler/cron";
import type { TaskView } from "@/lib/scheduler/jobs";
import type { ScheduledRunView } from "@/lib/scheduler/history";
import type { ModelRef } from "@/lib/models/preferences-schema";
import type { ApprovalRule } from "@/lib/approvals/rules";
import type { TaskEffort, TaskNotify } from "@/lib/scheduler/task-settings";

export type { TaskView, ScheduledRunView };

export type TaskDraft = {
  kind: "prompt" | "scheduledBackup" | "backupReminder";
  /** The wording template a new task was made from. */
  template?: "dailyBrief" | "weeklySummary";
  /** Empty, and a null prompt, leave that part to the template. */
  title: string;
  prompt?: string | null;
  enabled?: boolean;
  cron?: string | null;
  runAt?: string | null;
  timeZone: string;
  catchUp?: boolean;
  /** Null follows the default chat model. */
  model?: ModelRef | null;
  workspaceGrantId?: string | null;
  approvalRule?: ApprovalRule;
  usesMemory?: boolean;
  notify?: TaskNotify;
  reasoningEffort?: TaskEffort | null;
};

async function request<T>(path: string, init: RequestInit & { fallback: string }): Promise<T> {
  const { fallback, ...options } = init;
  const response = await fetch(path, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof payload?.error?.message === "string" ? payload.error.message : fallback);
  return payload as T;
}

const json = (method: string, body?: unknown): RequestInit => body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
const path = (id: string, action = "") => `/api/tasks/${encodeURIComponent(id)}${action}`;

export const taskApi = {
  list: (signal?: AbortSignal) => request<{ data: TaskView[]; automaticExecution: boolean }>("/api/tasks", { signal, fallback: t("tasks.loadFailed") }),
  runs: (signal?: AbortSignal) => request<{ data: ScheduledRunView[] }>("/api/tasks/runs", { signal, fallback: t("tasks.loadFailed") }),
  create: (draft: TaskDraft) => request<{ data: TaskView }>("/api/tasks", { ...json("POST", draft), fallback: t("tasks.saveFailed") }),
  update: (id: string, patch: Partial<Omit<TaskDraft, "kind">>) => request<{ data: TaskView }>(path(id), { ...json("PATCH", patch), fallback: t("tasks.saveFailed") }),
  remove: (id: string) => request<unknown>(path(id), { ...json("DELETE"), fallback: t("tasks.deleteFailed") }),
  run: (id: string) => request<unknown>(path(id, "/run"), { ...json("POST"), fallback: t("tasks.runFailed") }),
  stop: (id: string) => request<unknown>(path(id, "/stop"), { ...json("POST"), fallback: t("tasks.stopFailed") }),
};

const WORDED = ["dailyBrief", "weeklySummary"] as const;
type Worded = (typeof WORDED)[number];
const isWorded = (value: string | null | undefined): value is Worded => (WORDED as readonly string[]).includes(value ?? "");

/** A task's name as it reads now: its own, or its template's in the interface language. */
export function taskTitle(task: Pick<TaskView, "title" | "template">): string {
  return task.title || (isWorded(task.template) ? t(`tasks.template.${task.template}.title`) : "");
}

/** A task's prompt as it reads now: its own, or its template's in the interface language. */
export function taskPrompt(task: Pick<TaskView, "prompt" | "template">): string {
  return task.prompt ?? (isWorded(task.template) ? t(`tasks.template.${task.template}.prompt`) : "");
}

/**
 * What to save for a name and prompt: a part still reading exactly as the
 * template does in the current language goes back to the template, so it keeps
 * following the interface language; anything rewritten is kept as written.
 */
export function templateWording(template: string | null | undefined, title: string, prompt: string): { title: string; prompt: string | null } {
  if (!isWorded(template)) return { title, prompt };
  return {
    title: title === t(`tasks.template.${template}.title`) ? "" : title,
    prompt: prompt === t(`tasks.template.${template}.prompt`) ? null : prompt,
  };
}

export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** The weekday's name in the interface language; 0 is Sunday. */
export function weekdayName(day: number): string {
  // 4 January 1970 was a Sunday.
  return new Intl.DateTimeFormat(getLocale(), { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(1970, 0, 4 + day)));
}

/** Whether a task runs only when started by hand: no repeat and no time. */
export const isManualTask = (task: Pick<TaskView, "cron" | "nextRunAt">) => !task.cron && !task.nextRunAt;

/** When a task runs, in words: "每天 09:00", "每周一 09:00", the one time it is set for, or only by hand. */
export function describeSchedule(task: Pick<TaskView, "cron" | "nextRunAt" | "timeZone">): string {
  if (!task.nextRunAt && !task.cron) return t("tasks.schedule.manual");
  const preset = presetOfCron(task.cron);
  switch (preset.type) {
    case "once": return tf("tasks.schedule.once", { time: formatDateTime(task.nextRunAt!, { timeZone: task.timeZone }) });
    case "hourly": return tf("tasks.schedule.hourly", { minute: String(preset.minute).padStart(2, "0") });
    case "daily": return tf("tasks.schedule.daily", { time: preset.time });
    case "weekdays": return tf("tasks.schedule.weekdays", { time: preset.time });
    case "weekly": return tf("tasks.schedule.weekly", { day: weekdayName(preset.dayOfWeek), time: preset.time });
    case "monthly": return tf("tasks.schedule.monthly", { day: String(preset.dayOfMonth), time: preset.time });
    default: return tf("tasks.schedule.custom", { cron: preset.cron });
  }
}

export type TaskState = "running" | "waiting" | "failed" | "skipped" | "missed" | "paused" | "finished" | "scheduled" | "manual";

/** Where a task stands, as one word for its row. What it is doing now comes before how it last went. */
export function taskState(task: TaskView): TaskState {
  if (task.lastStatus === "running") return "running";
  if (task.lastStatus === "waiting_approval") return "waiting";
  // A task run only by hand is never due, so it is neither scheduled nor paused.
  if (isManualTask(task)) return task.lastStatus === "failed" || task.lastStatus === "interrupted" ? "failed" : "manual";
  // A one-off whose time has come and gone is off because it is finished, not because
  // someone paused it. One run by hand before its time and then switched off is paused.
  if (!task.enabled) return !task.cron && task.lastStatus === "done" && new Date(task.nextRunAt!).getTime() <= Date.now() ? "finished" : "paused";
  if (task.lastStatus === "skipped") return "skipped";
  if (task.lastStatus === "missed") return "missed";
  return task.lastStatus === "failed" || task.lastStatus === "interrupted" ? "failed" : "scheduled";
}
