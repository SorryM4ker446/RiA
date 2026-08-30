import { db } from "@/db";
import {
  encodePersistedAssistantToolMessage,
  encodePersistedUserMessage,
  getTextFromUIMessage,
  truncateTitle,
  type PersistedAssistantToolItem
} from "@/lib/ai/ui-message";
import { claimToolApproval, createChat, getChat, getRegenerationSnapshot, saveChatMessage, saveRegeneratedResponse } from "@/lib/chat/store";
import { ApiError, normalizeApiError } from "@/lib/server/api-error";
import { type UIMessage } from "ai";
import { persistResponseToolMemories } from "@/lib/chat/memory";
import type { ChatRequest } from "@/lib/chat/request";
async function getOrCreateChat(params: {
  requestedChatId?: string;
  userId: string;
  fallbackTitle: string;
}) {
  const { requestedChatId, userId, fallbackTitle } = params;

  if (requestedChatId) {
    const existing = await getChat(userId, requestedChatId);

    if (existing) {
      return existing;
    }

    const ownedByOthers = await db.chat.findUnique({
      where: { id: requestedChatId },
      select: { id: true },
    });

    if (ownedByOthers) {
      throw new ApiError({ code: "NOT_FOUND", message: "Conversation was not found" });
    }

    return createChat({
      userId,
      chatId: requestedChatId,
      title: fallbackTitle,
    });
  }

  return createChat({
    userId,
    title: fallbackTitle,
  });
}

function getToolItemsFromResponseMessage(message: UIMessage): PersistedAssistantToolItem[] {
  const parts = Array.isArray(message.parts) ? message.parts : [];

  return parts
    .filter(
      (part): part is UIMessage["parts"][number] & { type: `tool-${string}`; toolCallId: string; state: string } =>
        typeof part.type === "string" &&
        part.type.startsWith("tool-") &&
        "toolCallId" in part &&
        typeof part.toolCallId === "string" &&
        "state" in part &&
        typeof part.state === "string",
    )
    .map((part) => ({
      toolName: part.type.replace(/^tool-/, ""),
      toolCallId: part.toolCallId,
      state: part.state,
      ...("input" in part && part.input !== undefined ? { input: part.input } : {}),
      ...("output" in part && part.output !== undefined ? { output: part.output } : {}),
      ...("errorText" in part && typeof part.errorText === "string" ? { errorText: part.errorText } : {}),
      ...("approval" in part && part.approval ? { approval: part.approval } : {}),
    }));
}
export async function prepareChatPersistence(input: ChatRequest, userId: string) {
  const { body, messages, latestUserMessage, isApprovalResume, requestedChatId } = input;
  const titleSeed = latestUserMessage?.text || "New Chat";
  const chat = await getOrCreateChat({
    requestedChatId,
    userId,
    fallbackTitle: truncateTitle(titleSeed),
  });

  if (isApprovalResume) await claimToolApproval(userId, chat.id, messages[messages.length - 1]);

  if (latestUserMessage && !isApprovalResume) {
    const userContent =
      latestUserMessage.files.length > 0
        ? encodePersistedUserMessage({
          type: "user-message",
          text: latestUserMessage.text,
          files: latestUserMessage.files,
        })
        : latestUserMessage.text;

    await saveChatMessage({
      chatId: chat.id,
      role: "user",
      content: userContent,
      status: "success",
      clientMessageId: latestUserMessage.id,
    });
  }

  // Keep existing replies until a complete replacement has been generated.
  // Approval continuations update their assistant row and never truncate history.
  const regenerationSnapshot = body.trigger === "regenerate-message" && !isApprovalResume && latestUserMessage?.id
    ? await getRegenerationSnapshot(userId, chat.id, latestUserMessage.id)
    : null;

  return { chat, regenerationSnapshot };
}
export type ChatPersistence = Awaited<ReturnType<typeof prepareChatPersistence>>;
export async function persistChatResponse(params: { input: ChatRequest; conversation: ChatPersistence; userId: string; responseMessage: UIMessage; isAborted: boolean; generationFailed: boolean }) {
  const { input, conversation, userId, responseMessage, isAborted, generationFailed } = params;
  const { latestUserMessage, modelId } = input;
  const { chat, regenerationSnapshot } = conversation;
  try {
    const assistantText = getTextFromUIMessage(responseMessage).trim();
    const toolItems = getToolItemsFromResponseMessage(responseMessage);
    const content =
      toolItems.length > 0
        ? encodePersistedAssistantToolMessage({
          type: "assistant-tool-message",
          text: assistantText,
          tools: toolItems,
        })
        : assistantText;

    if (!content.trim()) return;

    if (regenerationSnapshot && latestUserMessage?.id) {
      if (isAborted || generationFailed) return;
      await saveRegeneratedResponse({
        snapshot: regenerationSnapshot,
        userMessageId: latestUserMessage.id,
        content,
        clientMessageId: responseMessage.id,
      });
    } else {
      await saveChatMessage({
        chatId: chat.id,
        role: "assistant",
        content,
        status: isAborted || generationFailed ? "error" : "success",
        clientMessageId: responseMessage.id,
        updateExisting: true,
      });
    }

    await db.chat.update({
      where: { id: chat.id },
      data: {
        lastMessageAt: new Date(),
        updatedAt: new Date(),
        title:
          chat.title === "New Chat" && latestUserMessage?.text
            ? truncateTitle(latestUserMessage.text)
            : chat.title,
      },
    });

    await persistResponseToolMemories({ userId, chatId: chat.id, toolItems, assistantText, modelId });
  } catch (persistError) {
    throw normalizeApiError(persistError, "回答保存失败，请重新加载会话后重试。");
  }
}

