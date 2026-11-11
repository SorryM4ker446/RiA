import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { identifierSchema } from "@/lib/server/request-schemas";
import { readJsonBody } from "@/lib/server/request-body";
import { deleteTask, taskPatchSchema, updateTask } from "@/lib/scheduler/jobs";

type Params = { params: Promise<{ id: string }> };

export const PATCH = protectDataOperation(async (req: NextRequest, context: Params) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("tasks");
    const identifier = identifierSchema.safeParse((await context.params).id);
    if (!identifier.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid id" });
    const parsed = taskPatchSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid task", details: parsed.error.flatten() });
    const data = await updateTask(identifier.data, parsed.data);
    if (!data) throw new ApiError({ code: "NOT_FOUND", message: "Task not found" });
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to update task");
  }
});

export const DELETE = protectDataOperation(async (req: NextRequest, context: Params) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("tasks");
    const identifier = identifierSchema.safeParse((await context.params).id);
    if (!identifier.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid id" });
    const result = await deleteTask(identifier.data);
    // Reporting a delete of a row that is not there as a success would let the
    // interface show the entry going away and then find it again on the next load.
    if (!result.deleted) throw new ApiError({ code: "NOT_FOUND", message: "Task not found" });
    return Response.json({ data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to delete task");
  }
});
