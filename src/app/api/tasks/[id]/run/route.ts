import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { identifierSchema } from "@/lib/server/request-schemas";
import { readEmptyBody } from "@/lib/server/request-body";
import { startTaskNow } from "@/lib/scheduler/runner";

/** Starts the task now and answers once it has started; the run carries on by itself. */
export const POST = protectDataOperation(async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("tasks");
    await readEmptyBody(req);
    const identifier = identifierSchema.safeParse((await context.params).id);
    if (!identifier.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid id" });
    const { task } = await startTaskNow(identifier.data);
    return Response.json({ data: { runId: task.runId } }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return createApiErrorResponse(error, "Failed to start task");
  }
});
