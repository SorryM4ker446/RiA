import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { TaskStatus } from "@prisma/client";
import { db } from "@/db";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { readJsonBody } from "@/lib/server/request-body";
import { createTask, createTaskInputSchema } from "@/tools/definitions/create-task";

const taskListQuerySchema = z.object({
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

async function GETHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    const parsed = taskListQuerySchema.safeParse({
      status: req.nextUrl.searchParams.get("status") ?? undefined,
      limit: req.nextUrl.searchParams.get("limit") ?? undefined,
    });

    if (!parsed.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid task query",
        details: parsed.error.flatten(),
      });
    }

    const tasks = await db.task.findMany({
      where: {
        ...(parsed.data.status ? { status: parsed.data.status as TaskStatus } : {}),
      },
      orderBy: [{ createdAt: "desc" }],
      take: parsed.data.limit,
    });

    return Response.json({ data: tasks });
  } catch (error) {
    console.error("/api/tasks GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to fetch tasks");
  }
}

// A task the user creates on the tasks page is their own record: it is saved
// directly, not run as a tool, so it leaves no execution or memory behind.
async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    const parsed = createTaskInputSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: "Invalid task",
        details: parsed.error.flatten(),
      });
    }
    const created = await createTask(parsed.data);
    const task = await db.task.findUniqueOrThrow({ where: { id: created.taskId } });
    return Response.json({ data: task }, { status: 201 });
  } catch (error) {
    console.error("/api/tasks POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to create task");
  }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
