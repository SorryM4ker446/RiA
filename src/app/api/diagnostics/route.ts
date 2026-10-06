import type { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { exportExecutionDiagnostics } from "@/lib/scheduler/history";

export const GET = protectDataOperation(async (req: NextRequest) => {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("conversationExport");
    return Response.json(await exportExecutionDiagnostics(), { headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": 'attachment; filename="ria-execution-diagnostics.json"',
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return createApiErrorResponse(error, "无法导出诊断信息。"); }
});
