import type { NextRequest } from "next/server";
import { z } from "zod";
import { protectDataOperation } from "@/lib/server/data-operations";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { isTaskTimeZone } from "@/lib/tasks/schedule";
import { previewWorkspaceReview } from "@/lib/activity/reviews";
const query = z.strictObject({ period: z.enum(["daily", "weekly"]), timeZone: z.string().min(1).max(100).refine(isTaskTimeZone) });
export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("conversationSearch");
    const params = [...req.nextUrl.searchParams];
    if (new Set(params.map(([key]) => key)).size !== params.length) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "Duplicate review query parameters" });
    }
    const input = query.parse(Object.fromEntries(params));
    return Response.json({ data: await previewWorkspaceReview(input.period, input.timeZone) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, "无法读取事实回顾。"); }
});
