import { z } from "zod";

/*
 * What a task decides about its runs besides when they happen. Kept free of
 * the database so the task form can use the same lists.
 */

/** How hard the model reasons on a task's turns. Null follows the app's setting. */
export const TASK_EFFORTS = ["off", "low", "high", "max"] as const;
export type TaskEffort = (typeof TASK_EFFORTS)[number];
export const taskEffortSchema = z.enum(TASK_EFFORTS).nullable();
export const readTaskEffort = (value: unknown): TaskEffort | null => taskEffortSchema.catch(null).parse(value ?? null);

/**
 * Which of a task's outcomes become system notifications. The notice in the
 * app's reminder center is raised either way; this only decides whether the
 * desktop also puts it on screen.
 */
export const TASK_NOTIFY = ["all", "important", "off"] as const;
export type TaskNotify = (typeof TASK_NOTIFY)[number];
export const taskNotifySchema = z.enum(TASK_NOTIFY);
export const readTaskNotify = (value: unknown): TaskNotify => taskNotifySchema.catch("all").parse(value);

/** Whether a notice titled after a run's outcome is shown on screen for a task set to `notify`. */
export function taskNotifies(notify: TaskNotify, noticeTitle: string): boolean {
  if (notify === "off") return false;
  // A run that simply finished is the one outcome that needs nothing from the user.
  return notify === "all" || noticeTitle !== "task-finished";
}
