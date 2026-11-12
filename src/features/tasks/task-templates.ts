import { t } from "@/lib/locale";
import type { SchedulePreset } from "@/lib/scheduler/cron";
import type { TaskKind } from "@/lib/scheduler/jobs";

/**
 * Ready-made starting points for a new task.
 *
 * A template only fills in the form: the user reads it, changes what they like,
 * and saves it or not. Nothing is created or switched on because a template
 * exists. The brief and the summary are prompts like any other, and their
 * wording follows the interface language at the moment the form is opened.
 */
export const TASK_TEMPLATES = ["custom", "dailyBrief", "weeklySummary", "scheduledBackup", "backupReminder"] as const;
export type TaskTemplateId = (typeof TASK_TEMPLATES)[number];

export type TaskTemplate = { kind: TaskKind; title: string; prompt: string; schedule: SchedulePreset };

export function taskTemplate(id: TaskTemplateId): TaskTemplate {
  switch (id) {
    case "dailyBrief":
      return { kind: "prompt", title: t("tasks.template.dailyBrief.title"), prompt: t("tasks.template.dailyBrief.prompt"), schedule: { type: "daily", time: "09:00" } };
    case "weeklySummary":
      return { kind: "prompt", title: t("tasks.template.weeklySummary.title"), prompt: t("tasks.template.weeklySummary.prompt"), schedule: { type: "weekly", time: "09:00", dayOfWeek: 1 } };
    case "scheduledBackup":
      return { kind: "scheduledBackup", title: t("tasks.kind.scheduledBackup"), prompt: "", schedule: { type: "daily", time: "03:00" } };
    case "backupReminder":
      return { kind: "backupReminder", title: t("tasks.kind.backupReminder"), prompt: "", schedule: { type: "weekly", time: "09:00", dayOfWeek: 1 } };
    default:
      return { kind: "prompt", title: "", prompt: "", schedule: { type: "daily", time: "09:00" } };
  }
}
