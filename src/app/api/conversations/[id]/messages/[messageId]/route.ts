import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { requireRequestUser } from "@/lib/auth/request-user";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { migrateMessageMedia, prepareMessageMedia, replaceMessageMedia } from "@/lib/media/messages";

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
      chatId: conversationId,
      chat: { userId },
      OR: [{ id: messageId }, { clientMessageId: messageId }],
    },
  });
}

export async function GET(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id: conversationId, messageId } = await context.params;

    const message = await getScopedMessage(user.id, conversationId, messageId);
    if (!message) {
      return Response.json({ error: "Message not found" }, { status: 404 });
    }

    return Response.json({ data: await migrateMessageMedia(user.id, message) });
  } catch (error) {
    console.error("/api/conversations/[id]/messages/[messageId] GET error", error);
    return createApiErrorResponse(error, "Failed to fetch message");
  }
}

export async function PATCH(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id: conversationId, messageId } = await context.params;
    const parsed = updateMessageSchema.safeParse(await readJsonBody(req));

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

    const prepared = parsed.data.content ? await prepareMessageMedia(user.id, parsed.data.content) : null;
    const updated = await db.$transaction(async (tx) => {
      const message = await tx.message.update({
        where: { id: existing.id },
        data: {
          ...(prepared ? { content: prepared.content } : {}),
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
        },
      });

      if (prepared) await replaceMessageMedia(tx, user.id, message.id, prepared.assetIds);
      return message;
    });
    return Response.json({ data: updated });
  } catch (error) {
    console.error("/api/conversations/[id]/messages/[messageId] PATCH error", error);
    return createApiErrorResponse(error, "Failed to update message");
  }
}

export async function DELETE(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id: conversationId, messageId } = await context.params;

    const existing = await getScopedMessage(user.id, conversationId, messageId);
    if (!existing) {
      return Response.json({ error: "Message not found" }, { status: 404 });
    }

    await db.$transaction(async (tx) => {
      await tx.mediaAsset.updateMany({ where: { userId: user.id, references: { some: { messageId: existing.id } } }, data: { lastUsedAt: new Date() } });
      await tx.message.delete({ where: { id: existing.id } });
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error("/api/conversations/[id]/messages/[messageId] DELETE error", error);
    return createApiErrorResponse(error, "Failed to delete message");
  }
}
