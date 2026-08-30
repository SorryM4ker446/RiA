import { MessageRole, MessageStatus } from "@prisma/client";
import type { UIMessage } from "ai";
import { db } from "@/db";
import { decodePersistedAssistantToolMessage, encodePersistedAssistantToolMessage, truncateTitle } from "@/lib/ai/ui-message";
import { ApiError } from "@/lib/server/api-error";
import { migrateMessageMedia, prepareMessageMedia, replaceMessageMedia } from "@/lib/media/messages";
import { pageResult, type PageOptions } from "@/lib/server/pagination";

export async function listChats(userId: string, options: PageOptions) {
  const cursor = options.cursor;
  const rows = await db.chat.findMany({
    where: { userId, ...(cursor ? { OR: [
      { lastMessageAt: { lt: cursor.date } },
      { lastMessageAt: cursor.date, id: { lt: cursor.id } },
    ] } : {}) },
    orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
    include: {
      _count: {
        select: { messages: true },
      },
    },
  });
  return pageResult(rows, options, `chats:${userId}`, (row) => row.lastMessageAt);
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

  await db.$transaction(async (tx) => {
    await tx.mediaAsset.updateMany({ where: { userId, references: { some: { message: { chatId } } } }, data: { lastUsedAt: new Date() } });
    await tx.chat.delete({ where: { id: chatId } });
  });

  return true;
}

export async function listChatMessagePage(userId: string, chatId: string, options: PageOptions) {
  if (!await getChat(userId, chatId)) return null;
  const cursor = options.cursor;
  const rows = await db.message.findMany({
    where: { chatId, ...(cursor ? { OR: [
      { createdAt: { lt: cursor.date } },
      { createdAt: cursor.date, id: { lt: cursor.id } },
    ] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
  });
  const page = pageResult(rows, options, `messages:${userId}:${chatId}`, (row) => row.createdAt);
  const data = [];
  for (const message of page.data.reverse()) data.push(await migrateMessageMedia(userId, message));
  return { ...page, data };
}

export async function saveChatMessage(params: {
  chatId: string;
  role: MessageRole;
  content: string;
  status?: MessageStatus;
  clientMessageId?: string;
  updateExisting?: boolean;
}) {
  const { chatId, role, content, status = "success", clientMessageId, updateExisting = false } = params;
  const normalizedClientMessageId = clientMessageId?.trim() ? clientMessageId.trim() : undefined;
  const chat = await db.chat.findUnique({ where: { id: chatId }, select: { userId: true } });
  if (!chat) throw new ApiError({ code: "NOT_FOUND", message: "Conversation was not found" });
  const prepared = await prepareMessageMedia(chat.userId, content);

  return db.$transaction(async (tx) => {
    const data = {
      chatId,
      role,
      content: prepared.content,
      status,
      ...(normalizedClientMessageId ? { clientMessageId: normalizedClientMessageId } : {}),
    };
    const message = normalizedClientMessageId
      ? await tx.message.upsert({
          where: { chatId_clientMessageId: { chatId, clientMessageId: normalizedClientMessageId } },
          create: data,
          update: updateExisting ? { content: prepared.content, status } : {},
        })
      : await tx.message.create({ data });
    if (message.content === prepared.content) await replaceMessageMedia(tx, chat.userId, message.id, prepared.assetIds);
    await tx.chat.update({ where: { id: chatId }, data: { lastMessageAt: new Date() } });
    return message;
  });
}

export async function getRegenerationSnapshot(userId: string, chatId: string, messageId: string) {
  const target = await db.message.findFirst({ where: {
    chatId, chat: { userId }, role: "user", OR: [{ id: messageId }, { clientMessageId: messageId }],
  } });
  if (!target) {
    throw new ApiError({ code: "NOT_FOUND", message: "Message to regenerate was not found" });
  }
  const from = { createdAt: target.createdAt, id: target.id };
  const rows = await db.message.findMany({
    where: { chatId, ...fromMessage(from) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const messages = [];
  for (const message of rows) messages.push(await migrateMessageMedia(userId, message));
  return { userId, chatId, from, messages };
}

function fromMessage(from: { createdAt: Date; id: string }) {
  return { OR: [{ createdAt: { gt: from.createdAt } }, { createdAt: from.createdAt, id: { gte: from.id } }] };
}

/** Claim a persisted pending approval once, before any side effect is executed. */
export async function claimToolApproval(userId: string, chatId: string, message: UIMessage) {
  const existing = await db.message.findFirst({ where: {
    chatId, chat: { userId }, role: "assistant",
    OR: [{ id: message.id }, { clientMessageId: message.id }],
  } });
  const persisted = existing ? decodePersistedAssistantToolMessage(existing.content) : null;
  if (!existing || !persisted) {
    throw new ApiError({ code: "NOT_FOUND", message: "Pending tool approval was not found" });
  }
  const decisions = message.parts.filter((part) => "state" in part && part.state === "approval-responded");
  if (decisions.length === 0) throw new ApiError({ code: "VALIDATION_ERROR", message: "Approval decision is required" });
  for (const part of decisions) {
    if (!("toolCallId" in part) || !("approval" in part) || !part.approval || typeof part.approval.approved !== "boolean") {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid approval decision" });
    }
    const stored = persisted.tools.find((tool) => tool.toolCallId === part.toolCallId);
    if (!stored || stored.state !== "approval-requested" || stored.approval?.id !== part.approval.id) {
      throw new ApiError({ code: "CONFLICT", message: "This approval is no longer pending; refresh the conversation" });
    }
    if (part.type !== `tool-${stored.toolName}` || JSON.stringify(part.input) !== JSON.stringify(stored.input)) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "Tool approval input does not match the pending request" });
    }
    stored.state = "approval-responded";
    stored.approval = part.approval;
  }
  const claimed = await db.message.updateMany({
    where: { id: existing.id, content: existing.content },
    data: { content: encodePersistedAssistantToolMessage(persisted) },
  });
  if (claimed.count !== 1) {
    throw new ApiError({ code: "CONFLICT", message: "This approval has already been processed" });
  }
}

export async function saveRegeneratedResponse(params: {
  snapshot: Awaited<ReturnType<typeof getRegenerationSnapshot>>;
  userMessageId: string;
  content: string;
  clientMessageId: string;
}) {
  const { snapshot } = params;
  return db.$transaction(async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: snapshot.chatId, userId: snapshot.userId } });
    if (!chat) throw new ApiError({ code: "NOT_FOUND", message: "Conversation was not found" });
    const current = await tx.message.findMany({
      where: { chatId: snapshot.chatId, ...fromMessage(snapshot.from) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    // A concurrent edit/send must not be discarded by a slower generation.
    if (JSON.stringify(current) !== JSON.stringify(snapshot.messages)) {
      throw new ApiError({ code: "CONFLICT", message: "Conversation changed while regenerating; original messages were preserved" });
    }
    const index = current.findIndex((message) =>
      message.role === "user" && (message.id === params.userMessageId || message.clientMessageId === params.userMessageId),
    );
    if (index < 0) throw new ApiError({ code: "NOT_FOUND", message: "Message to regenerate was not found" });
    const removedIds = current.slice(index + 1).map((message) => message.id);
    await tx.mediaAsset.updateMany({ where: { userId: snapshot.userId, references: { some: { messageId: { in: removedIds } } } }, data: { lastUsedAt: new Date() } });
    await tx.message.deleteMany({ where: { id: { in: removedIds } } });
    const message = await tx.message.create({ data: {
      chatId: snapshot.chatId,
      role: "assistant",
      content: params.content,
      status: "success",
      clientMessageId: params.clientMessageId,
    } });
    await tx.chat.update({ where: { id: snapshot.chatId }, data: { lastMessageAt: new Date() } });
    return message;
  });
}
