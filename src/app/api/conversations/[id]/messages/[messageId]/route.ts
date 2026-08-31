import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { requireRequestUser } from "@/lib/auth/request-user";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { migrateMessageMedia, prepareMessageMedia, replaceMessageMedia } from "@/lib/media/messages";

const updateMessageSchema = z.strictObject({
  content: z.string().min(1).max(1_000_000).optional(),
  status: z.enum(["pending", "success", "error"]).optional(),
}).refine((body) => Object.keys(body).length > 0, "At least one field is required");

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

async function GETHandler(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id: conversationId, messageId } = await context.params;

    const message = await getScopedMessage(user.id, conversationId, messageId);
    if (!message) {
      throw new ApiError({ code: "NOT_FOUND", message: "Message not found" });
    }

    return Response.json({ data: await migrateMessageMedia(user.id, message) });
  } catch (error) {
    console.error("/api/conversations/[id]/messages/[messageId] GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to fetch message");
  }
}

async function PATCHHandler(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id: conversationId, messageId } = await context.params;
    const parsed = updateMessageSchema.safeParse(await readJsonBody(req));

    if (!parsed.success) {
      throw parsed.error;
    }

    const existing = await getScopedMessage(user.id, conversationId, messageId);
    if (!existing) {
      throw new ApiError({ code: "NOT_FOUND", message: "Message not found" });
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
    console.error("/api/conversations/[id]/messages/[messageId] PATCH error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to update message");
  }
}

async function DELETEHandler(req: NextRequest, context: Params) {
  try {
    const user = await requireRequestUser(req);
    const { id: conversationId, messageId } = await context.params;

    const existing = await getScopedMessage(user.id, conversationId, messageId);
    if (!existing) {
      throw new ApiError({ code: "NOT_FOUND", message: "Message not found" });
    }

    await db.$transaction(async (tx) => {
      await tx.mediaAsset.updateMany({ where: { userId: user.id, references: { some: { messageId: existing.id } } }, data: { lastUsedAt: new Date() } });
      await tx.message.delete({ where: { id: existing.id } });
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error("/api/conversations/[id]/messages/[messageId] DELETE error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to delete message");
  }
}

export const GET = protectDataOperation(GETHandler);
export const PATCH = protectDataOperation(PATCHHandler);
export const DELETE = protectDataOperation(DELETEHandler);
