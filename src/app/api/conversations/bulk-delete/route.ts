import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { bulkDeleteSchema, deleteConversations } from "@/lib/conversations/mutations";

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("conversationBulkDelete");
    const input = bulkDeleteSchema.parse(await readJsonBody(req, 16 * 1024));
    return Response.json({ data: { deletedCount: await deleteConversations(input.ids) } });
  } catch (error) { return createApiErrorResponse(error, "Failed to delete conversations"); }
}

export const POST = protectDataOperation(POSTHandler);
