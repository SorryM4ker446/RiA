import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { TaskStatus } from "@prisma/client";
import { db } from "@/db";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { requireRequestUser } from "@/lib/auth/request-user";

const taskListQuerySchema = z.object({
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

async function GETHandler(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
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
        userId: user.id,
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

export const GET = protectDataOperation(GETHandler);
