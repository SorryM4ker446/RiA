import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { protectDataOperation } from "@/lib/server/data-operations";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { getChat } from "@/lib/chat/store";
import { listSubagents } from "@/lib/agents/subagents";
import { t } from "@/lib/locale";

type Params = { params: Promise<{ id: string }> };

/** The conversation's sub-agents, oldest first, as their cards show them. */
async function GETHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    const { id } = await context.params;
    if (!await getChat(id)) throw new ApiError({ code: "NOT_FOUND", message: t("server.conversation.notFound") });
    return Response.json({ data: await listSubagents(id) });
  } catch (error) {
    console.error("/api/conversations/[id]/subagents GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to list sub-agents");
  }
}

export const GET = protectDataOperation(GETHandler);
