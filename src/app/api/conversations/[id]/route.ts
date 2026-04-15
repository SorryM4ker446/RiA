import { NextRequest } from "next/server";
import { z } from "zod";
import { getOrCreateRequestUser } from "@/lib/auth/request-user";
import { deleteChat, getChat, listChatMessages, updateChatTitle } from "@/lib/chat/store";

const updateConversationSchema = z.object({
  title: z.string().min(1).max(200),
});

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(req: NextRequest, context: Params) {
  try {
    const user = await getOrCreateRequestUser(req);
    const { id } = await context.params;

    const conversation = await getChat(user.id, id);

    if (!conversation) {
      return Response.json({ error: "Conversation not found" }, { status: 404 });
    }

    const messages = await listChatMessages(user.id, id);
    const messageCount = messages?.length ?? 0;

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
    console.error("/api/conversations/[id] GET error", error);
    return Response.json({ error: "Failed to fetch conversation" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, context: Params) {
  try {
    const user = await getOrCreateRequestUser(req);
    const { id } = await context.params;
    const parsed = updateConversationSchema.safeParse(await req.json());

    if (!parsed.success) {
      return Response.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const updated = await updateChatTitle(user.id, id, parsed.data.title);
    if (!updated) {
      return Response.json({ error: "Conversation not found" }, { status: 404 });
    }

    return Response.json({ data: updated });
  } catch (error) {
    console.error("/api/conversations/[id] PATCH error", error);
    return Response.json({ error: "Failed to update conversation" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, context: Params) {
  try {
    const user = await getOrCreateRequestUser(req);
    const { id } = await context.params;

    const deleted = await deleteChat(user.id, id);
    if (!deleted) {
      return Response.json({ error: "Conversation not found" }, { status: 404 });
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error("/api/conversations/[id] DELETE error", error);
    return Response.json({ error: "Failed to delete conversation" }, { status: 500 });
  }
}
