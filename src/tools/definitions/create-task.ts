import { z } from "zod";
import { TaskPriority, TaskStatus } from "@prisma/client";
import { db } from "@/db";

export const createTaskInputSchema = z.object({
  title: z.string().min(1, "title is required").max(120),
  details: z.string().max(2000).optional(),
  dueDate: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional().default("medium"),
});

export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export type CreateTaskOutput = {
  taskId: string;
  title: string;
  details: string | null;
  dueDate: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  createdAt: string;
};

function parseDueDate(value?: string): Date | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export async function createTask(userId: string, input: CreateTaskInput): Promise<CreateTaskOutput> {
  const dueDate = parseDueDate(input.dueDate);

  const task = await db.task.create({
    data: {
      userId,
      title: input.title.trim(),
      details: input.details?.trim() || null,
      dueDate,
      priority: input.priority ?? "medium",
      status: "todo",
    },
  });

  return {
    taskId: task.id,
    title: task.title,
    details: task.details,
    dueDate: task.dueDate ? task.dueDate.toISOString() : null,
    priority: task.priority,
    status: task.status,
    createdAt: task.createdAt.toISOString(),
  };
}
