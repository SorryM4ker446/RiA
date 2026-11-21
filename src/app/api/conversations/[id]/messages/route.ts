import { protectDataOperation } from "@/lib/server/data-operations";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { getChat, listChatMessagePage, saveChatMessage } from "@/lib/chat/store";
import { readJsonBody } from "@/lib/server/request-body";
import { readPageOptions } from "@/lib/server/pagination";

import { t } from "@/lib/locale";
const createMessageSchema = z.strictObject({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1).max(1_000_000),
  clientMessageId: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  status: z.enum(["pending", "success", "error"]).optional(),
});

type Params = {
  params: Promise<{ id: string }>;
};

async function GETHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);const { id: chatId } = await context.params;

    const page = await listChatMessagePage(chatId, readPageOptions(req.nextUrl.searchParams, `messages:${chatId}`, 50));
    if (!page) {
      throw new ApiError({ code: "NOT_FOUND", message: t("server.conversation.notFound") });
    }

    return Response.json(page);
  } catch (error) {
    console.error("/api/conversations/[id]/messages GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to fetch messages");
  }
}

async function POSTHandler(req: NextRequest, context: Params) {
  try {
    await requireLocalWorkspace(req);const { id: chatId } = await context.params;
    const parsed = createMessageSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) throw parsed.error;
    const chat = await getChat(chatId);
    if (!chat) {
      throw new ApiError({ code: "NOT_FOUND", message: t("server.conversation.notFound") });
    }

    const message = await saveChatMessage({
      chatId: chat.id,
      role: parsed.data.role,
      content: parsed.data.content,
      clientMessageId: parsed.data.clientMessageId,
      status: parsed.data.status ?? "success",
    });

    return Response.json({ data: message }, { status: 201 });
  } catch (error) {
    console.error("/api/conversations/[id]/messages POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to create message");
  }
}

export const GET = protectDataOperation(GETHandler);
export const POST = protectDataOperation(POSTHandler);
