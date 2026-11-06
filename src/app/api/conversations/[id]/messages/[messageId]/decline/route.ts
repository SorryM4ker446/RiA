import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { declineToolApprovals } from "@/lib/chat/store";
import { t } from "@/lib/locale";

type Params = {
  params: Promise<{ id: string; messageId: string }>;
};

/** Rejects a reply's pending approvals without asking the model to continue. */
async function POSTHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);
    const { id: conversationId, messageId } = await context.params;
    const toolCallIds = await declineToolApprovals(conversationId, messageId, t("chat.messages.approvalRejectedReason"));
    return Response.json({ data: { toolCallIds } });
  } catch (error) {
    console.error("/api/conversations/[id]/messages/[messageId]/decline POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to reject the request");
  }
}

export const POST = protectDataOperation(POSTHandler);
