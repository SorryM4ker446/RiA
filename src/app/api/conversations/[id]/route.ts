import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRequestUser } from "@/lib/auth/request-user";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { deleteChat, getChat, updateChatTitle } from "@/lib/chat/store";
import { db } from "@/db";

const updateConversationSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
});

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id } = await context.params;

    const conversation = await getChat(user.id, id);

    if (!conversation) {
      throw new ApiError({ code: "NOT_FOUND", message: "Conversation not found" });
    }

    const messageCount = await db.message.count({ where: { chatId: id, chat: { userId: user.id } } });

    return Response.json({
      data: {
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        lastMessageAt: conversation.lastMessageAt,
        messageCount,
      },
    });
  } catch (error) {
    console.error("/api/conversations/[id] GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to fetch conversation");
  }
}

export async function PATCH(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id } = await context.params;
    const parsed = updateConversationSchema.safeParse(await readJsonBody(req));

    if (!parsed.success) {
      throw parsed.error;
    }

    const updated = await updateChatTitle(user.id, id, parsed.data.title);
    if (!updated) {
      throw new ApiError({ code: "NOT_FOUND", message: "Conversation not found" });
    }

    return Response.json({ data: updated });
  } catch (error) {
    console.error("/api/conversations/[id] PATCH error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to update conversation");
  }
}

export async function DELETE(req: NextRequest, context: Params) {
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
