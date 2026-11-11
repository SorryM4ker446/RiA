import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { identifierSchema } from "@/lib/server/request-schemas";
import { readEmptyBody } from "@/lib/server/request-body";
import { stopTask } from "@/lib/scheduler/runner";

export const POST = protectDataOperation(async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("tasks");
    await readEmptyBody(req);
    const identifier = identifierSchema.safeParse((await context.params).id);
    if (!identifier.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid id" });
    if (!stopTask(identifier.data)) throw new ApiError({ code: "CONFLICT", message: "The task is not running" });
    return Response.json({ data: { stopping: true } }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to stop task");
  }
});
