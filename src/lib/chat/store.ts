import { defaultApprovalRule } from "@/lib/approvals/preferences";
import { MessageRole, MessageStatus, type Message, type Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import { db } from "@/db";
import { decodePersistedAssistantToolMessage, encodePersistedAssistantToolMessage, truncateTitle } from "@/lib/ai/ui-message";
import { ApiError } from "@/lib/server/api-error";
import { migrateMessageMedia, prepareMessageMedia, replaceMessageMedia } from "@/lib/media/messages";
import { pageResult, type PageOptions } from "@/lib/server/pagination";
import { deleteConversations, updateConversation } from "@/lib/conversations/mutations";
import { resolveAssistant } from "@/lib/assistants/store";
import { announceConversationsChanged } from "@/lib/conversations/events";

const summaryInvalidation = {
  historyRevision: { increment: 1 }, summary: null, summaryUpToMessageId: null, summaryModelId: null, summaryRevision: null, summaryState: null,
};

/**
 * What rewriting a stored message does to the summary, run before the write.
 *
 * Saving a new message changes no history, so it leaves everything alone; the
 * answer ending every turn is saved this way, and clearing the summary there would
 * have each long conversation summarized from scratch on every request. Rewriting
 * a message advances the revision, which refuses any summary still being written
 * from the old text. The stored summary goes too, unless it provably ends before
 * that message, as it does for an answer continuing after an approval. A summary
 * with no end marks only tool calls folded during the turn, whose ids a rewrite of
 * that turn keeps, so it stays as well.
 */
function rewriteStatements(client: Pick<Prisma.TransactionClient, "$executeRaw">, chatId: string, messageRef: string) {
  return [
    client.$executeRaw`
      UPDATE "chats" SET "historyRevision" = "historyRevision" + 1, "summary" = NULL, "summaryUpToMessageId" = NULL, "summaryModelId" = NULL, "summaryRevision" = NULL, "summaryState" = NULL
      WHERE "id" = ${chatId}
        AND EXISTS (SELECT 1 FROM "messages" m WHERE m."chatId" = ${chatId} AND m."clientMessageId" = ${messageRef})
        AND NOT ("summary" IS NOT NULL AND "summaryState" IS NOT NULL AND "summaryUpToMessageId" IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM "messages" m JOIN "messages" c ON c."id" = "chats"."summaryUpToMessageId" AND c."chatId" = m."chatId"
          WHERE m."chatId" = ${chatId} AND m."clientMessageId" = ${messageRef}
            AND (c."createdAt" < m."createdAt" OR (c."createdAt" = m."createdAt" AND c."id" < m."id")))`,
    // Whatever the statement above did not clear is still valid at the new revision.
    client.$executeRaw`
      UPDATE "chats" SET "historyRevision" = "historyRevision" + 1,
        "summaryRevision" = CASE WHEN "summaryRevision" = "historyRevision" THEN "historyRevision" + 1 ELSE "summaryRevision" END
      WHERE "id" = ${chatId}
        AND EXISTS (SELECT 1 FROM "messages" m WHERE m."chatId" = ${chatId} AND m."clientMessageId" = ${messageRef})
        AND "summary" IS NOT NULL`,
  ];
}

export async function getChat(chatId: string) {
  return db.chat.findFirst({ where: { id: chatId } });
}

export async function createChat(params: { chatId?: string; title?: string; assistantTemplateId?: string; ephemeral?: boolean }) {
  const { chatId, title } = params;

  if (chatId) {
    const existing = await db.chat.findFirst({ where: { id: chatId } });
    if (existing) return existing;
  }

  const assistant = params.assistantTemplateId ? await resolveAssistant(params.assistantTemplateId) : null;
  const created = await db.chat.create({
    data: {
      // A new conversation starts from the default approval rule; changing the default later leaves it as it is.
      approvalRule: await defaultApprovalRule(),
      ...(assistant ? { assistantConfig: assistant, ephemeral: !assistant.usesMemory } : {}),
      ...(chatId ? { id: chatId } : {}),
      ...(params.ephemeral === undefined ? {} : { ephemeral: params.ephemeral }),
      title: truncateTitle(title ?? assistant?.name ?? "New Chat"),
      lastMessageAt: new Date(),
    },
  });
  announceConversationsChanged();
  return created;
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
  const data = {
    chatId, role, content: prepared.content, status,
    ...(normalizedClientMessageId ? { clientMessageId: normalizedClientMessageId } : {}),
  };
  const writeMessage = (client: Prisma.TransactionClient) => normalizedClientMessageId
    ? client.message.upsert({
        where: { chatId_clientMessageId: { chatId, clientMessageId: normalizedClientMessageId } },
        create: data,
        update: updateExisting ? { content: prepared.content, status } : {},
      })
    : client.message.create({ data });

  if (updateExisting && prepared.assetIds.length === 0) {
    // Approval continuations carry complete scripts. These writes need no
    // JavaScript read between queries, so keep them atomic in an engine-side
    // batch instead of expiring an interactive transaction during serialization.
    const message = normalizedClientMessageId
      ? { chatId, clientMessageId: normalizedClientMessageId }
      : { id: { in: [] as string[] } };
    const rewrite = normalizedClientMessageId ? rewriteStatements(db, chatId, normalizedClientMessageId) : [];
    const saved = (await db.$transaction([
      ...rewrite,
      db.mediaAsset.updateMany({ where: { references: { some: { message } } }, data: { lastUsedAt: new Date() } }),
      db.messageMedia.deleteMany({ where: { message } }),
      normalizedClientMessageId
        // Bind a large body once. The ORM upsert serializes both create.content
        // and update.content even though SQLite only uses one of them.
        ? db.$queryRaw<Message[]>`
            INSERT INTO "messages" ("id", "chatId", "clientMessageId", "role", "content", "status", "createdAt")
            VALUES (${randomUUID()}, ${chatId}, ${normalizedClientMessageId}, ${role}, ${prepared.content}, ${status}, ${new Date()})
            ON CONFLICT ("chatId", "clientMessageId") DO UPDATE SET
              "content" = excluded."content", "status" = excluded."status"
            RETURNING "id", "chatId", "clientMessageId", "role", "content", "status", "createdAt"
          `
        : db.message.create({ data }),
      db.chat.update({ where: { id: chatId }, data: { lastMessageAt: new Date() } }),
    ])).at(-2) as Message | Message[];
    announceConversationsChanged();
    return Array.isArray(saved) ? saved[0] : saved;
  }

  const saved = await db.$transaction(async (tx) => {
    if (updateExisting && normalizedClientMessageId) for (const statement of rewriteStatements(tx, chatId, normalizedClientMessageId)) await statement;
    const message = await writeMessage(tx);
    if (message.content === prepared.content) await replaceMessageMedia(tx, message.id, prepared.assetIds);
    await tx.chat.update({ where: { id: chatId }, data: { lastMessageAt: new Date() } });
    return message;
  });
  announceConversationsChanged();
  return saved;
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
  return [...new Set([...(persisted.runIds ?? []), ...(persisted.runId ? [persisted.runId] : [])])];
}

/**
 * Rejects every pending approval in a reply without continuing the turn, for a model that
 * cannot call tools and so cannot carry on from either answer. Nothing runs; the calls are
 * recorded as rejected, and the conversation goes on from the next message.
 */
export async function declineToolApprovals(chatId: string, messageId: string, reason: string) {
  const existing = await db.message.findFirst({ where: {
    chatId, role: "assistant",
    OR: [{ id: messageId }, { clientMessageId: messageId }],
  } });
  const persisted = existing ? decodePersistedAssistantToolMessage(existing.content) : null;
  if (!existing || !persisted) throw new ApiError({ code: "NOT_FOUND", message: "Pending tool approval was not found" });
  const pending = persisted.tools.filter(tool => tool.state === "approval-requested" && tool.approval?.id);
  if (!pending.length) throw new ApiError({ code: "CONFLICT", message: "This approval is no longer pending; refresh the conversation" });
  for (const tool of pending) {
    tool.state = "output-denied";
    tool.approval = { ...tool.approval!, approved: false, reason };
  }
  // Guarded on the content read, so a decision made at the same moment elsewhere wins once.
  const declined = await db.message.updateMany({
    where: { id: existing.id, content: existing.content },
    data: { content: encodePersistedAssistantToolMessage(persisted) },
  });
  if (declined.count !== 1) throw new ApiError({ code: "CONFLICT", message: "This approval has already been processed" });
  return pending.map(tool => tool.toolCallId);
}

/**
 * Restores an approval that was claimed but never reached tool execution, so
 * the user can retry the same decision after a failed preparation step. The
 * restore only applies while the row still holds this claim's decision.
 */
export async function releaseUnclaimedToolApproval(chatId: string, message: UIMessage) {
  const existing = await db.message.findFirst({ where: {
    chatId, role: "assistant",
    OR: [{ id: message.id }, { clientMessageId: message.id }],
  } });
  const persisted = existing ? decodePersistedAssistantToolMessage(existing.content) : null;
  if (!existing || !persisted) return;
  const decisions = message.parts.filter((part) => "state" in part && part.state === "approval-responded");
  const claimed = persisted.tools.filter((tool) => decisions.some((part) => "toolCallId" in part && part.toolCallId === tool.toolCallId));
  if (claimed.length === 0) return;
  for (const tool of claimed) {
    if (tool.state !== "approval-responded") return;
    if (!tool.approval || typeof tool.approval.approved !== "boolean") return;
    tool.state = "approval-requested";
  }
  await db.message.updateMany({
    where: { id: existing.id, content: existing.content },
    data: { content: encodePersistedAssistantToolMessage(persisted) },
  });
}

export async function saveRegeneratedResponse(params: {
  snapshot: Awaited<ReturnType<typeof getRegenerationSnapshot>>;
  userMessageId: string;
  content: string;
  clientMessageId: string;
}) {
  const { snapshot } = params;
  const saved = await db.$transaction(async (tx) => {
    const chat = await tx.chat.findFirst({ where: { id: snapshot.chatId } });
    if (!chat) throw new ApiError({ code: "NOT_FOUND", message: "Conversation was not found" });
    const current = await tx.message.findMany({
      where: { chatId: snapshot.chatId, ...fromMessage(snapshot.from) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    // A concurrent edit/send must not be discarded by a slower generation.
    // What a request was sent with is written as the request starts, and changes nothing a person wrote.
    const compared = (messages: typeof current) => JSON.stringify(messages.map(({ requestContext: _sentWith, ...message }) => message));
    if (compared(current) !== compared(snapshot.messages)) {
      throw new ApiError({ code: "CONFLICT", message: "Conversation changed while regenerating; original messages were preserved" });
    }
    const index = current.findIndex((message) =>
      message.role === "user" && (message.id === params.userMessageId || message.clientMessageId === params.userMessageId),
    );
    if (index < 0) throw new ApiError({ code: "NOT_FOUND", message: "Message to regenerate was not found" });
    const removedIds = current.slice(index + 1).map((message) => message.id);
    await tx.mediaAsset.updateMany({ where: { references: { some: { messageId: { in: removedIds } } } }, data: { lastUsedAt: new Date() } });
    await invalidateChatSummary(tx, snapshot.chatId);
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
  announceConversationsChanged();
  return saved;
}

/** Rewrite evidence invalidates compression in the same transaction. */
export async function invalidateChatSummary(tx: Prisma.TransactionClient, chatId: string) {
  await tx.chat.update({ where: { id: chatId }, data: summaryInvalidation });
}
