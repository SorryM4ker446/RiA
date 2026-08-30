import { z } from "zod";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { isTaskTimeZone, nextTaskDueDate, parseTaskDueDate, TASK_REPEAT_RULES, type TaskRepeatRule } from "@/lib/tasks/schedule";

export const taskScheduleFields = {
  dueDate: z.string().max(100).nullable().optional(),
  timeZone: z.string().max(100).refine(isTaskTimeZone, "Invalid IANA time zone").optional(),
  reminderEnabled: z.boolean().optional(),
  repeatRule: z.enum(TASK_REPEAT_RULES).optional(),
};

export const updateTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(120).optional(),
  details: z.string().max(2000).nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  ...taskScheduleFields,
}).refine(value => Object.keys(value).length > 0, "At least one field is required");

export function resolveTaskSchedule(input: {
  dueDate?: string | null; timeZone?: string; reminderEnabled?: boolean; repeatRule?: TaskRepeatRule;
}) {
  const timeZone = input.timeZone ?? "UTC";
  const reminderEnabled = input.reminderEnabled ?? false;
  const repeatRule = input.repeatRule ?? "none";
  let dueDate: Date | null;
  try { dueDate = parseTaskDueDate(input.dueDate, timeZone); }
  catch (error) { throw new ApiError({ code: "VALIDATION_ERROR", message: (error as Error).message }); }
  if ((reminderEnabled || repeatRule !== "none") && !dueDate) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "提醒和重复任务必须设置截止时间。" });
  }
  return { dueDate, timeZone, reminderEnabled, repeatRule };
}

export async function updateTask(userId: string, id: string, input: z.infer<typeof updateTaskSchema>, now = new Date()) {
  return db.$transaction(async tx => {
    const existing = await tx.task.findFirst({ where: { id, userId } });
    if (!existing) throw new ApiError({ code: "NOT_FOUND", message: "Task not found" });
    const schedule = resolveTaskSchedule({
      dueDate: input.dueDate === undefined ? existing.dueDate?.toISOString() : input.dueDate,
      timeZone: input.timeZone ?? existing.timeZone,
      reminderEnabled: input.reminderEnabled ?? existing.reminderEnabled,
      repeatRule: input.repeatRule ?? existing.repeatRule as TaskRepeatRule,
    });
    const dueChanged = schedule.dueDate?.getTime() !== existing.dueDate?.getTime();
    const scheduleChanged = dueChanged || schedule.timeZone !== existing.timeZone || schedule.repeatRule !== existing.repeatRule;
    const repeatAnchor = scheduleChanged ? schedule.dueDate : existing.repeatAnchor ?? schedule.dueDate;
    const updated = await tx.task.update({ where: { id }, data: {
      ...schedule,
      repeatAnchor,
      ...(dueChanged ? { remindedAt: null } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.details !== undefined ? { details: input.details?.trim() || null } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.status ? { status: input.status } : {}),
    } });
    let nextTask = null;
    if (updated.status === "done" && existing.status !== "done" && !existing.repeatGenerated && schedule.repeatRule !== "none") {
      let dueDate: Date;
      try { dueDate = nextTaskDueDate(repeatAnchor!, schedule.dueDate!, schedule.repeatRule, schedule.timeZone, now); }
      catch (error) { throw new ApiError({ code: "VALIDATION_ERROR", message: (error as Error).message }); }
      // Persist the completion and successor atomically, including after the successor is deleted.
      await tx.task.update({ where: { id }, data: { repeatGenerated: true } });
      updated.repeatGenerated = true;
      nextTask = await tx.task.create({ data: {
        userId, title: updated.title, details: updated.details, priority: updated.priority,
        ...schedule, dueDate, repeatAnchor,
      } });
    }
    return { data: updated, nextTask };
  });
}

export async function claimTaskReminders(userId: string, now = new Date()) {
  return db.$transaction(async tx => {
    const tasks = await tx.task.findMany({
      where: { userId, reminderEnabled: true, remindedAt: null, dueDate: { lte: now }, status: { not: "done" } },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }], take: 10,
      select: { id: true, title: true, dueDate: true, timeZone: true },
    });
    await tx.task.updateMany({ where: { id: { in: tasks.map(task => task.id) }, userId, remindedAt: null }, data: { remindedAt: now } });
    return tasks;
  });
}
