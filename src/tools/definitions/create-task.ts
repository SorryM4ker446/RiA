import { z } from "zod";
import { TaskPriority, TaskStatus } from "@prisma/client";
import { db } from "@/db";
import { resolveTaskSchedule, taskScheduleFields } from "@/lib/tasks/service";

export const createTaskInputSchema = z.strictObject({
  title: z.string().trim().min(1, "title is required").max(120),
  details: z.string().max(2000).optional(),
  priority: z.enum(["low", "medium", "high"]).optional().default("medium"),
  ...taskScheduleFields,
}).superRefine((value, context) => {
  try { resolveTaskSchedule(value); }
  catch (error) { context.addIssue({ code: "custom", message: (error as Error).message, path: ["dueDate"] }); }
});

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export type CreateTaskOutput = {
  taskId: string;
  title: string;
  details: string | null;
  dueDate: string | null;
  timeZone: string;
  reminderEnabled: boolean;
  repeatRule: string;
  priority: TaskPriority;
  status: TaskStatus;
  createdAt: string;
};

export async function createTask(userId: string, input: CreateTaskInput): Promise<CreateTaskOutput> {
  const schedule = resolveTaskSchedule(input);

  const task = await db.task.create({
    data: {
      userId,
      title: input.title.trim(),
      details: input.details?.trim() || null,
      ...schedule,
      repeatAnchor: schedule.dueDate,
      priority: input.priority ?? "medium",
      status: "todo",
    },
  });

  return {
    taskId: task.id,
    title: task.title,
    details: task.details,
    dueDate: task.dueDate ? task.dueDate.toISOString() : null,
    timeZone: task.timeZone,
    reminderEnabled: task.reminderEnabled,
    repeatRule: task.repeatRule,
    priority: task.priority,
    status: task.status,
    createdAt: task.createdAt.toISOString(),
  };
}
