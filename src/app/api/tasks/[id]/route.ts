import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { updateTask, updateTaskSchema } from "@/lib/tasks/service";

type Params = {
  params: Promise<{ id: string }>;
};

async function getScopedTask(taskId: string) {
  return db.task.findFirst({
    where: {
      id: taskId,
    },
  });
}

async function GETHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    const { id } = await context.params;
    const task = await getScopedTask(id);

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

async function PATCHHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    const { id } = await context.params;
    const parsed = updateTaskSchema.safeParse(await readJsonBody(req));

    if (!parsed.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid task update",
        details: parsed.error.flatten(),
      });
    }

    return Response.json(await updateTask(id, parsed.data));
  } catch (error) {
    console.error("/api/tasks/[id] PATCH error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to update task");
  }
}

async function DELETEHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    const { id } = await context.params;
    const existing = await getScopedTask(id);

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

export const GET = protectDataOperation(GETHandler);
export const PATCH = protectDataOperation(PATCHHandler);
export const DELETE = protectDataOperation(DELETEHandler);
