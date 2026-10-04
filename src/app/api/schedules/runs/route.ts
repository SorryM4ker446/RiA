import type { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { HISTORY_LIMITS, listScheduledRuns } from "@/lib/scheduler/history";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    return Response.json({ data: await listScheduledRuns(), retention: HISTORY_LIMITS,
      automaticExecution: process.env.APP_RUNTIME === "desktop",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return createApiErrorResponse(error, "无法读取执行历史。"); }
});
