import { NextRequest } from "next/server";
import { storedSummary } from "@/lib/chat/model-context";
import { TASK_STATE_VERSION } from "@/lib/chat/task-summary";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { protectDataOperation } from "@/lib/server/data-operations";

type Params = { params: Promise<{ id: string }> };

/**
 * The summary standing in for a conversation's earlier turns, for the reader to
 * look at, and the message it ends after. A conversation with none has nothing to
 * show, which is not an error, whether or not it has been saved yet.
 */
async function GETHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    const { id } = await context.params;
    const stored = await storedSummary(id);
    const data = stored ? { summary: stored.summary.replace(TASK_STATE_VERSION, "").trim(), coveredIds: stored.coveredIds } : null;
    return Response.json({ data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("/api/conversations/[id]/summary GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to load the conversation summary");
  }
}

export const GET = protectDataOperation(GETHandler);
