import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { stopSubagent } from "@/lib/agents/subagents";
import { t } from "@/lib/locale";

type Params = { params: Promise<{ id: string; subagentId: string }> };

/** Stops one sub-agent of the conversation, from its card. One that has already ended is left as it is. */
async function POSTHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    const { id, subagentId } = await context.params;
    if (!/^sa_[a-f0-9]{12}$/.test(subagentId)) throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.subagent.notFound") });
    return Response.json({ data: { stopped: stopSubagent(id, subagentId) } });
  } catch (error) {
    console.error("/api/conversations/[id]/subagents/[subagentId]/stop POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to stop the sub-agent");
  }
}

export const POST = protectDataOperation(POSTHandler);
