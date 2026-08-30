import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { requireRequestUser } from "@/lib/auth/request-user";
import { updateTask, updateTaskSchema } from "@/lib/tasks/service";

type Params = {
  params: Promise<{ id: string }>;
};

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
    console.error("/api/tasks/[id] GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to fetch task");
  }
}

export async function PATCH(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id } = await context.params;
    const parsed = updateTaskSchema.safeParse(await readJsonBody(req));

    if (!parsed.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid task update",
        details: parsed.error.flatten(),
      });
    }

    return Response.json(await updateTask(user.id, id, parsed.data));
  } catch (error) {
    console.error("/api/tasks/[id] PATCH error", normalizeApiError(error).code);
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
    console.error("/api/tasks/[id] DELETE error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to delete task");
  }
}
