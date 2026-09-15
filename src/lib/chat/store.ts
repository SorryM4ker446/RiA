import { MessageRole, MessageStatus } from "@prisma/client";
import type { UIMessage } from "ai";
import { db } from "@/db";
import { decodePersistedAssistantToolMessage, encodePersistedAssistantToolMessage, truncateTitle } from "@/lib/ai/ui-message";
import { ApiError } from "@/lib/server/api-error";
import { migrateMessageMedia, prepareMessageMedia, replaceMessageMedia } from "@/lib/media/messages";
import { pageResult, type PageOptions } from "@/lib/server/pagination";
import { deleteConversations, updateConversation } from "@/lib/conversations/mutations";

export async function getChat(chatId: string) {
  return db.chat.findFirst({ where: { id: chatId } });
}

export async function createChat(params: { chatId?: string; title?: string }) {
  const { chatId, title } = params;

  if (chatId) {
    const existing = await db.chat.findFirst({ where: { id: chatId } });
    if (existing) return existing;
  }

  return db.chat.create({
    data: {
      ...(chatId ? { id: chatId } : {}),
      title: truncateTitle(title ?? "New Chat"),
      lastMessageAt: new Date(),
    },
  });
}

export async function deleteChat(chatId: string) {
  const existing = await getChat(chatId);
  if (!existing) return false;

  await deleteConversations([chatId]);

  return true;
}

export async function updateChatTitle(chatId: string, title: string) {
  if (!await getChat(chatId)) return null;
  return updateConversation(chatId, { title });
}

export async function listChatMessagePage(chatId: string, options: PageOptions) {
  if (!await getChat(chatId)) return null;
  const cursor = options.cursor;
  const rows = await db.message.findMany({
    where: { chatId, ...(cursor ? { OR: [
      { createdAt: { lt: cursor.date } },
      { createdAt: cursor.date, id: { lt: cursor.id } },
    ] } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
  });
  const page = pageResult(rows, options, `messages:${chatId}`, (row) => row.createdAt);
  const data = [];
  for (const message of page.data.reverse()) data.push(await migrateMessageMedia(message));
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
  const chat = await db.chat.findUnique({ where: { id: chatId }, select: { id: true } });
  if (!chat) throw new ApiError({ code: "NOT_FOUND", message: "Conversation was not found" });
  const prepared = await prepareMessageMedia(content);

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
    if (message.content === prepared.content) await replaceMessageMedia(tx, message.id, prepared.assetIds);
    await tx.chat.update({ where: { id: chatId }, data: { lastMessageAt: new Date() } });
    return message;
  });
}

export async function getRegenerationSnapshot(chatId: string, messageId: string) {
  const target = await db.message.findFirst({ where: {
    chatId, role: "user", OR: [{ id: messageId }, { clientMessageId: messageId }],
  } });
  if (!target) {
    throw new ApiError({ code: "NOT_FOUND", message: "Message to regenerate was not found" });
  }
  const from = { createdAt: target.createdAt, id: target.id };
  const rows = await db.message.findMany({
    where: { chatId, ...fromMessage(from) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const messages = [];
  for (const message of rows) messages.push(await migrateMessageMedia(message));
  return { chatId, from, messages };
}

function fromMessage(from: { createdAt: Date; id: string }) {
  return { OR: [{ createdAt: { gt: from.createdAt } }, { createdAt: from.createdAt, id: { gte: from.id } }] };
}

/** Claim a persisted pending approval once, before any side effect is executed. */
export async function claimToolApproval(chatId: string, message: UIMessage) {
  const existing = await db.message.findFirst({ where: {
    chatId, role: "assistant",
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
    const chat = await tx.chat.findFirst({ where: { id: snapshot.chatId } });
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
    await tx.mediaAsset.updateMany({ where: { references: { some: { messageId: { in: removedIds } } } }, data: { lastUsedAt: new Date() } });
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
