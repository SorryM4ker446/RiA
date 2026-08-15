import { NextRequest } from "next/server";
import { z } from "zod";
import { requireRequestUser } from "@/lib/auth/request-user";
import { truncateTitle } from "@/lib/ai/ui-message";
import { createApiErrorResponse } from "@/lib/server/api-error";
import { createChat, listChats } from "@/lib/chat/store";

const createConversationSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1).max(200).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);

    const conversations = await listChats(user.id);

    return Response.json({
      data: conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        lastMessageAt: conversation.lastMessageAt,
        messageCount: conversation._count.messages,
      })),
    });
  } catch (error) {
    console.error("/api/conversations GET error", error);
    return createApiErrorResponse(error, "Failed to fetch conversations");
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    const parsed = createConversationSchema.safeParse(await req.json());

    if (!parsed.success) {
      return Response.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const conversation = await createChat({
      userId: user.id,
      chatId: parsed.data.id,
      title: truncateTitle(parsed.data.title ?? "New Chat"),
    });

    return Response.json({ data: conversation }, { status: 201 });
  } catch (error) {
    console.error("/api/conversations POST error", error);
    return createApiErrorResponse(error, "Failed to create conversation");
  }
}
