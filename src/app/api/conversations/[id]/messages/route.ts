import { NextRequest } from "next/server";
import { z } from "zod";
import { getOrCreateRequestUser } from "@/lib/auth/request-user";
import { getChat, listChatMessages, saveChatMessage } from "@/lib/chat/store";

const createMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1),
  clientMessageId: z.string().min(1).optional(),
  status: z.enum(["pending", "success", "error"]).optional(),
});

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(req: NextRequest, context: Params) {
  try {
    const user = await getOrCreateRequestUser(req);
    const { id: chatId } = await context.params;

    const messages = await listChatMessages(user.id, chatId);
    if (!messages) {
      return Response.json({ error: "Conversation not found" }, { status: 404 });
    }

    return Response.json({ data: messages });
  } catch (error) {
    console.error("/api/conversations/[id]/messages GET error", error);
    return Response.json({ error: "Failed to fetch messages" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, context: Params) {
  try {
    const user = await getOrCreateRequestUser(req);
    const { id: chatId } = await context.params;
    const chat = await getChat(user.id, chatId);
    if (!chat) {
      return Response.json({ error: "Conversation not found" }, { status: 404 });
    }

    const parsed = createMessageSchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
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
    console.error("/api/conversations/[id]/messages POST error", error);
    return Response.json({ error: "Failed to create message" }, { status: 500 });
  }
}
