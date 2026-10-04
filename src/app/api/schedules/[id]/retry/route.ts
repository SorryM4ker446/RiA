import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { identifierSchema } from "@/lib/server/request-schemas";
import { readJsonBody } from "@/lib/server/request-body";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { retryScheduledJob } from "@/lib/scheduler/runner";

const input = z.strictObject({ runId: identifierSchema });
export const POST = protectDataOperation(async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("backups");
    const id = identifierSchema.parse((await context.params).id);
    const { runId } = input.parse(await readJsonBody(req, 4096));
    const result = await retryScheduledJob(id, runId);
    if (!result) throw new ApiError({ code: "CONFLICT", message: "无法发起新的执行。" });
    return Response.json({ data: result }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return createApiErrorResponse(error, "无法重试定时任务。"); }
});
