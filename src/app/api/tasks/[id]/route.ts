import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { requireRequestUser } from "@/lib/auth/request-user";

const updateTaskSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    details: z.string().max(2000).nullable().optional(),
    dueDate: z.string().nullable().optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    status: z.enum(["todo", "in_progress", "done"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field is required",
  });

type Params = {
  params: Promise<{ id: string }>;
};

function parseDueDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError({
      code: "VALIDATION_ERROR",
      message: "Invalid dueDate",
    });
  }
  return date;
}

async function getScopedTask(userId: string, taskId: string) {
  return db.task.findFirst({
    where: {
      id: taskId,
      userId,
    },
  });
}

export async function GET(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id } = await context.params;
    const task = await getScopedTask(user.id, id);

    if (!task) {
      throw new ApiError({
        code: "NOT_FOUND",
        message: "Task not found",
      });
    }

    return Response.json({ data: task });
  } catch (error) {
    console.error("/api/tasks/[id] GET error", error);
    return createApiErrorResponse(error, "Failed to fetch task");
  }
}

export async function PATCH(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id } = await context.params;
    const parsed = updateTaskSchema.safeParse(await req.json());

    if (!parsed.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid task update",
        details: parsed.error.flatten(),
      });
    }

    const existing = await getScopedTask(user.id, id);
    if (!existing) {
      throw new ApiError({
        code: "NOT_FOUND",
        message: "Task not found",
      });
    }

    const dueDate = parseDueDate(parsed.data.dueDate);
    const updated = await db.task.update({
      where: { id },
      data: {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title.trim() } : {}),
        ...(parsed.data.details !== undefined ? { details: parsed.data.details?.trim() || null } : {}),
        ...(dueDate !== undefined ? { dueDate } : {}),
        ...(parsed.data.priority ? { priority: parsed.data.priority } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
      },
    });

    return Response.json({ data: updated });
  } catch (error) {
    console.error("/api/tasks/[id] PATCH error", error);
    return createApiErrorResponse(error, "Failed to update task");
  }
}

export async function DELETE(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id } = await context.params;
    const existing = await getScopedTask(user.id, id);

    if (!existing) {
      throw new ApiError({
        code: "NOT_FOUND",
        message: "Task not found",
      });
    }

    await db.task.delete({
      where: { id },
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error("/api/tasks/[id] DELETE error", error);
    return createApiErrorResponse(error, "Failed to delete task");
  }
}
