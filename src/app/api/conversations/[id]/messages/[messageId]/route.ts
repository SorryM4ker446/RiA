import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { getOrCreateRequestUser } from "@/lib/auth/request-user";

const updateMessageSchema = z.object({
  content: z.string().min(1).optional(),
  status: z.enum(["pending", "success", "error"]).optional(),
});

type Params = {
  params: Promise<{ id: string; messageId: string }>;
};

async function getScopedMessage(userId: string, conversationId: string, messageId: string) {
  return db.message.findFirst({
    where: {
      id: messageId,
      chatId: conversationId,
      chat: { userId },
    },
  });
}

export async function GET(req: NextRequest, context: Params) {
  try {
    const user = await getOrCreateRequestUser(req);
    const { id: conversationId, messageId } = await context.params;

    const message = await getScopedMessage(user.id, conversationId, messageId);
    if (!message) {
      return Response.json({ error: "Message not found" }, { status: 404 });
    }

    return Response.json({ data: message });
  } catch (error) {
    console.error("/api/conversations/[id]/messages/[messageId] GET error", error);
    return Response.json({ error: "Failed to fetch message" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, context: Params) {
  try {
    const user = await getOrCreateRequestUser(req);
    const { id: conversationId, messageId } = await context.params;
    const parsed = updateMessageSchema.safeParse(await req.json());

    if (!parsed.success) {
      return Response.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const existing = await getScopedMessage(user.id, conversationId, messageId);
    if (!existing) {
      return Response.json({ error: "Message not found" }, { status: 404 });
    }

    const updated = await db.message.update({
      where: { id: messageId },
      data: {
        ...(parsed.data.content ? { content: parsed.data.content } : {}),
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
      },
    });

    return Response.json({ data: updated });
  } catch (error) {
    console.error("/api/conversations/[id]/messages/[messageId] PATCH error", error);
    return Response.json({ error: "Failed to update message" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, context: Params) {
  try {
    const user = await getOrCreateRequestUser(req);
    const { id: conversationId, messageId } = await context.params;

    const existing = await getScopedMessage(user.id, conversationId, messageId);
    if (!existing) {
      return Response.json({ error: "Message not found" }, { status: 404 });
    }

    await db.message.delete({
      where: { id: messageId },
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error("/api/conversations/[id]/messages/[messageId] DELETE error", error);
    return Response.json({ error: "Failed to delete message" }, { status: 500 });
  }
}
