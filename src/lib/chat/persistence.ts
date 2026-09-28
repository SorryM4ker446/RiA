import { db } from "@/db";
import { t } from "@/lib/locale";
import {
  encodePersistedAssistantToolMessage,
  encodePersistedUserMessage,
  getReasoningFromUIMessage,
  getTextFromUIMessage,
  truncateTitle,
  type PersistedAssistantToolItem
} from "@/lib/ai/ui-message";
import { claimToolApproval, createChat, getChat, getRegenerationSnapshot, releaseUnclaimedToolApproval, saveChatMessage, saveRegeneratedResponse } from "@/lib/chat/store";
import { ApiError, normalizeApiError } from "@/lib/server/api-error";
import { type UIMessage } from "ai";
import { persistResponseToolMemories } from "@/lib/chat/memory";
import type { ChatRequest } from "@/lib/chat/request";
import type { DocumentSource } from "@/lib/documents/types";
async function getOrCreateChat(params: {
  requestedChatId?: string;
  fallbackTitle: string;
}) {
  const { requestedChatId, fallbackTitle } = params;

  if (requestedChatId) {
    const existing = await getChat(requestedChatId);

    if (existing) {
      return existing;
    }

    const alreadyExists = await db.chat.findUnique({
      where: { id: requestedChatId },
      select: { id: true },
    });

    if (alreadyExists) {
      throw new ApiError({ code: "NOT_FOUND", message: "Conversation was not found" });
    }

    return createChat({
      chatId: requestedChatId,
      title: fallbackTitle,
    });
  }

  return createChat({
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
export async function prepareChatPersistence(input: ChatRequest) {
  const { body, messages, latestUserMessage, isApprovalResume, requestedChatId } = input;
  const titleSeed = latestUserMessage?.text || "New Chat";
  const chat = await getOrCreateChat({
    requestedChatId,
    fallbackTitle: truncateTitle(titleSeed),
  });

  if (isApprovalResume) {
    const lastMessage = messages[messages.length - 1];
    try {
      await claimToolApproval(chat.id, lastMessage);
    } catch (claimError) {
      // A validation refusal must not consume the pending approval.
      await releaseUnclaimedToolApproval(chat.id, lastMessage).catch(() => {});
      throw claimError;
    }
  }

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
    ? await getRegenerationSnapshot(chat.id, latestUserMessage.id)
    : null;

  return { chat, regenerationSnapshot };
}
export type ChatPersistence = Awaited<ReturnType<typeof prepareChatPersistence>>;
export async function persistChatResponse(params: { input: ChatRequest; conversation: ChatPersistence; responseMessage: UIMessage; isAborted: boolean; generationFailed: boolean; documentSources?: DocumentSource[]; unavailableTools?: string[]; usesMemory?: boolean }) {
  const { input, conversation, responseMessage, isAborted, generationFailed } = params;
  const { latestUserMessage, modelRef } = input;
  const { unavailableTools = [] } = params;
  const { chat, regenerationSnapshot } = conversation;
  try {
    const assistantText = getTextFromUIMessage(responseMessage).trim();
    const toolItems = getToolItemsFromResponseMessage(responseMessage);
    // Reasoning is kept with the message whether or not this answer used a
    // tool: the next turn's request may need it, and it cannot be recovered
    // after the fact.
    const reasoning = getReasoningFromUIMessage(responseMessage);
    const content =
      toolItems.length > 0 || reasoning || (params.documentSources?.length && assistantText)
        ? encodePersistedAssistantToolMessage({
          type: "assistant-tool-message",
          text: assistantText,
          ...(reasoning ? { reasoning } : {}),
          // Recorded so the note about a tool this turn could not use survives a
          // reload and is stated once, instead of only existing in the model's
          // prose or only in the live stream.
          ...(unavailableTools.length ? { unavailableTools } : {}),
          tools: toolItems,
          ...(params.documentSources?.length ? { documentSources: params.documentSources } : {}),
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

    // A rename made while the answer streamed must survive; only a conversation
    // still holding the auto-generated placeholder gets named from the message.
    if (chat.title === "New Chat" && latestUserMessage?.text) {
      await db.chat.updateMany({ where: { id: chat.id, title: "New Chat" }, data: { title: truncateTitle(latestUserMessage.text) } });
    }
    await db.chat.update({
      where: { id: chat.id },
      data: {
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      },
    });

    // An ephemeral conversation writes no long-term memory. The run record and
    // the messages still exist, which is what "no memory" is meant to mean.
    if (params.usesMemory !== false) {
      await persistResponseToolMemories({ chatId: chat.id, toolItems, assistantText, modelRef });
    }
  } catch (persistError) {
    throw normalizeApiError(persistError, t("lib.chat.saveFailed"));
  }
}
