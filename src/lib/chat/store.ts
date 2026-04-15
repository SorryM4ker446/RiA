import { MessageRole, MessageStatus } from "@prisma/client";
import { db } from "@/db";
import { truncateTitle } from "@/lib/ai/ui-message";

export async function listChats(userId: string) {
  return db.chat.findMany({
    where: { userId },
    orderBy: [{ lastMessageAt: "desc" }],
    include: {
      _count: {
        select: { messages: true },
      },
    },
  });
}

export async function getChat(userId: string, chatId: string) {
  return db.chat.findFirst({
    where: {
      id: chatId,
      userId,
    },
  });
}

export async function createChat(params: { userId: string; chatId?: string; title?: string }) {
  const { userId, chatId, title } = params;

  if (chatId) {
    const existing = await db.chat.findFirst({
      where: { id: chatId, userId },
    });
    if (existing) return existing;
  }

  return db.chat.create({
    data: {
      ...(chatId ? { id: chatId } : {}),
      userId,
      title: truncateTitle(title ?? "New Chat"),
      lastMessageAt: new Date(),
    },
  });
}

export async function updateChatTitle(userId: string, chatId: string, title: string) {
  const existing = await getChat(userId, chatId);
  if (!existing) return null;

  return db.chat.update({
    where: { id: chatId },
    data: {
      title: truncateTitle(title),
    },
  });
}

export async function deleteChat(userId: string, chatId: string) {
  const existing = await getChat(userId, chatId);
  if (!existing) return false;

  await db.chat.delete({
    where: { id: chatId },
  });

  return true;
}

export async function listChatMessages(userId: string, chatId: string) {
  const existing = await getChat(userId, chatId);
  if (!existing) return null;

  const messages = await db.message.findMany({
    where: { chatId },
    orderBy: [{ createdAt: "asc" }],
  });

  return messages;
}

export async function getRecentChatMessages(chatId: string, limit = 10) {
  return db.message.findMany({
    where: { chatId },
    orderBy: [{ createdAt: "desc" }],
    take: limit,
  });
}

export async function saveChatMessage(params: {
  chatId: string;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  clientMessageId?: string;
}) {
  const { chatId, role, content, status = "success", clientMessageId } = params;

  if (clientMessageId) {
    const existing = await db.message.findFirst({
      where: { chatId, clientMessageId },
    });

    if (existing) return existing;
  }

  const message = await db.message.create({
    data: {
      chatId,
      role,
      content,
      status,
      clientMessageId,
    },
  });

  await db.chat.update({
    where: { id: chatId },
    data: { lastMessageAt: new Date() },
  });

  return message;
}
