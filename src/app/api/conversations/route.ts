import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRequestUser } from "@/lib/auth/request-user";
import { truncateTitle } from "@/lib/ai/ui-message";
import { createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { createChat, listChats } from "@/lib/chat/store";
import { readPageOptions } from "@/lib/server/pagination";

const createConversationSchema = z.strictObject({
  id: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);

    const page = await listChats(user.id, readPageOptions(req.nextUrl.searchParams, `chats:${user.id}`, 30));

    return Response.json({
      pageInfo: page.pageInfo,
      data: page.data.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        lastMessageAt: conversation.lastMessageAt,
        messageCount: conversation._count.messages,
      })),
    });
  } catch (error) {
    console.error("/api/conversations GET error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to fetch conversations");
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    const parsed = createConversationSchema.safeParse(await readJsonBody(req));

    if (!parsed.success) {
      throw parsed.error;
    }

    const conversation = await createChat({
      userId: user.id,
      chatId: parsed.data.id,
      title: truncateTitle(parsed.data.title ?? "New Chat"),
    });

    return Response.json({ data: conversation }, { status: 201 });
  } catch (error) {
    console.error("/api/conversations POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to create conversation");
  }
}
