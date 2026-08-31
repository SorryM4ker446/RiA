import { protectDataOperation } from "@/lib/server/data-operations";
import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest } from "next/server";
import { requireRequestUser } from "@/lib/auth/request-user";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { deleteChat } from "@/lib/chat/store";
import { db } from "@/db";
import { updateConversation, updateConversationSchema } from "@/lib/conversations/mutations";
import { conversationSummary } from "@/lib/conversations/query";

type Params = {
  params: Promise<{ id: string }>;
};

async function GETHandler(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id } = await context.params;

    const conversation = await db.chat.findFirst({ where: { id, userId: user.id }, include: { tags: { orderBy: { label: "asc" } }, _count: { select: { messages: true } } } });

    if (!conversation) {
      throw new ApiError({ code: "NOT_FOUND", message: "Conversation not found" });
    }

    return Response.json({ data: conversationSummary(conversation) });
  } catch (error) {
    console.error("/api/conversations/[id] GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to fetch conversation");
  }
}

async function PATCHHandler(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id } = await context.params;
    const parsed = updateConversationSchema.safeParse(await readJsonBody(req));

    if (!parsed.success) {
      throw parsed.error;
    }

    const updated = await updateConversation(user.id, id, parsed.data);

    return Response.json({ data: updated });
  } catch (error) {
    console.error("/api/conversations/[id] PATCH error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to update conversation");
  }
}

async function DELETEHandler(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id } = await context.params;

    const deleted = await deleteChat(user.id, id);
    if (!deleted) {
      throw new ApiError({ code: "NOT_FOUND", message: "Conversation not found" });
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error("/api/conversations/[id] DELETE error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to delete conversation");
  }
}

export const GET = protectDataOperation(GETHandler);
export const PATCH = protectDataOperation(PATCHHandler);
export const DELETE = protectDataOperation(DELETEHandler);
