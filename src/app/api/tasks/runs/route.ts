import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { identifierSchema } from "@/lib/server/request-schemas";
import { HISTORY_LIMITS, listScheduledRuns } from "@/lib/scheduler/history";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    const taskId = req.nextUrl.searchParams.get("taskId");
    const identifier = taskId === null ? null : identifierSchema.safeParse(taskId);
    if (identifier && !identifier.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid id" });
    return Response.json({ data: await listScheduledRuns(identifier?.data), retention: HISTORY_LIMITS }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to read task runs");
  }
});
