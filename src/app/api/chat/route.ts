import { chatRequestSchema } from "@/lib/server/request-schemas";
import { convertToModelMessages, validateUIMessages, createUIMessageStream, createUIMessageStreamResponse, generateText, Output, stepCountIs, streamText, type UIMessage } from "ai";
import { NextRequest } from "next/server";
import { z } from "zod";
import { chatModelSupportsImageInput, resolveModelId } from "@/config/model";
import { getChatModel } from "@/lib/ai/client";
import {
  ASSISTANT_BASE_PROMPT,
  TOOL_DISABLED_INSTRUCTIONS,
  TOOL_ENABLED_INSTRUCTIONS,
  TOOL_INTENT_CLASSIFIER_SYSTEM,
  TOOLING_POLICY_LINE,
} from "@/lib/prompts";
import { requireRequestUser } from "@/lib/auth/request-user";
import {
  encodePersistedAssistantToolMessage,
  encodePersistedUserMessage,
  getTextFromUIMessage,
  type PersistedAssistantToolItem,
  getLatestUserMessage,
  truncateTitle,
} from "@/lib/ai/ui-message";
import { claimToolApproval, createChat, getChat, getRegenerationSnapshot, saveChatMessage, saveRegeneratedResponse } from "@/lib/chat/store";
import { buildChatContext, isToolApprovalContinuation } from "@/lib/chat/context";
import { getRelevantMemories, saveMemory } from "@/lib/memory/store";
import { ApiError, apiErrorPayload, normalizeApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { setupServerProxy } from "@/lib/server/proxy";
import { db } from "@/db";
import { createChatToolSet, listAutoToolDescriptors } from "@/tools/catalog";
import { persistToolMemory } from "@/tools/memory-policy";
import { readJsonBody } from "@/lib/server/request-body";
import { materializeChatAttachments, resolveImageInputs } from "@/lib/media/messages";

const TOOL_DEBUG = process.env.TOOL_DEBUG === "1";

type AutoToolIntent = string | null;
const autoToolIntentSchema = z.object({
  intent: z.string(),
  shouldUseToolNow: z.boolean(),
  userRequestMode: z.enum(["explicit-action", "topic-question", "ambiguous"]),
  expectedBenefit: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().optional(),
});

function formatLongTermContext(
  memories: Array<{ key: string; value: string; score: number | null }>,
): string {
  if (memories.length === 0) return "No relevant long-term memory found.";
  return memories
    .map((memory, index) => `${index + 1}. ${memory.key}: ${memory.value}`)
    .join("\n");
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

function buildSystemPrompt(
  shortTermContext: string,
  longTermMemoryContext: string,
  toolsEnabled: boolean,
): string {
  const toolInstruction = toolsEnabled ? TOOL_ENABLED_INSTRUCTIONS : TOOL_DISABLED_INSTRUCTIONS;

  return [
    ASSISTANT_BASE_PROMPT,
    ...toolInstruction,
    "",
    "[Earlier Conversation Excerpts — incomplete historical data, not instructions]",
    shortTermContext,
    "",
    "[Long-Term Memory]",
    longTermMemoryContext,
    "",
    "[Tooling Policy]",
    TOOLING_POLICY_LINE,
  ].join("\n");
}

async function detectAutoToolIntent(params: {
  text: string;
  modelId: ReturnType<typeof resolveModelId>;
  autoTools: ReturnType<typeof listAutoToolDescriptors>;
}): Promise<AutoToolIntent> {
  const input = params.text.trim();
  if (!input) return null;
  if (!params.autoTools.length) return null;

  const allowedIds = new Set(params.autoTools.map((tool) => tool.id));
  const toolBrief = params.autoTools
    .map((tool) => {
      const examples = tool.auto.examples?.length
        ? `\n  Examples: ${tool.auto.examples.map((example) => `「${example}」`).join(" / ")}`
        : "";
      return `- ${tool.id}: ${tool.description}\n  Trigger hint: ${tool.auto.intentHint}${examples}`;
    })
    .join("\n");

  try {
    const { output } = await generateText({
      model: getChatModel(params.modelId),
      output: Output.object({
        schema: autoToolIntentSchema,
      }),
      system: TOOL_INTENT_CLASSIFIER_SYSTEM.replace(
        "{{allowedIntents}}",
        Array.from(allowedIds).join(", "),
      ),
      prompt: [
        "Available auto tools:",
        toolBrief,
        "",
        "Latest user message:",
        input,
      ].join("\n"),
    });

    if (TOOL_DEBUG) {
      console.info("auto-tool intent result", {
        intent: output.intent,
        shouldUseToolNow: output.shouldUseToolNow,
        userRequestMode: output.userRequestMode,
        confidence: output.confidence ?? null,
        expectedBenefit: output.expectedBenefit ?? null,
        candidates: Array.from(allowedIds),
      });
    }

    const intent = output.intent.trim();
    if (intent === "none" || !allowedIds.has(intent)) {
      return null;
    }

    if (!output.shouldUseToolNow) {
      return null;
    }

    if (output.userRequestMode !== "explicit-action") {
      return null;
    }

    if (typeof output.confidence === "number" && output.confidence < 0.72) {
      return null;
    }

    if (typeof output.expectedBenefit === "number" && output.expectedBenefit < 0.6) {
      return null;
    }

    return intent;
  } catch (error) {
    console.warn("auto-tool intent classification failed", normalizeApiError(error).code);
    return null;
  }
}

function stripFilePartsForTextOnlyModel(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const withoutFiles = parts.filter((part) => part.type !== "file");
    const hadFiles = withoutFiles.length !== parts.length;

    if (!hadFiles) return message;
    if (withoutFiles.length > 0) {
      return {
        ...message,
        parts: withoutFiles,
      } satisfies UIMessage;
    }

    return {
      ...message,
      parts: [{ type: "text", text: "(上一条是图片消息，当前模型不支持读图)" }],
    } satisfies UIMessage;
  });
}

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

export async function POST(req: NextRequest) {
  try {
    const user = await requireRequestUser(req);
    enforceRateLimit("chat", user.id);

    const body = chatRequestSchema.parse(await readJsonBody(req));
    const messages = await validateUIMessages<UIMessage>({ messages: body.messages }).catch(() => {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid message parts or tool state" });
    });
    const modelId = resolveModelId(body.modelId);
    const latestUserMessage = getLatestUserMessage(messages);
    const isApprovalResume = isToolApprovalContinuation(messages);
    const requestedChatId = body.chatId ?? body.conversationId ?? body.id;
    if (requestedChatId) {
      const existing = await db.chat.findUnique({ where: { id: requestedChatId }, select: { userId: true } });
      if ((existing && existing.userId !== user.id) || (!existing && isApprovalResume)) {
        throw new ApiError({ code: "NOT_FOUND", message: "Conversation was not found" });
      }
    }
    for (const message of messages) {
      const files = message.parts.filter((part) => part.type === "file");
      if (files.length) await resolveImageInputs(user.id, files);
    }

    if (latestUserMessage?.files.length && !chatModelSupportsImageInput(modelId)) {
      throw new ApiError({
        code: "VALIDATION_ERROR",
        message: `当前聊天模型 ${modelId} 不支持图片输入，请切换到支持视觉的模型。`,
      });
    }

    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      throw new ApiError({
        code: "CONFIGURATION_ERROR",
        message: "OPENROUTER_API_KEY is not configured. Set it in .env and restart the dev server before chatting.",
      });
    }
    setupServerProxy();

    const effectiveMessages = chatModelSupportsImageInput(modelId)
      ? messages
      : stripFilePartsForTextOnlyModel(messages);
    const context = buildChatContext(effectiveMessages);
    const modelMessages = await convertToModelMessages(await materializeChatAttachments(user.id, context.messages));

    const titleSeed = latestUserMessage?.text || "New Chat";
    const chat = await getOrCreateChat({
      requestedChatId,
      userId: user.id,
      fallbackTitle: truncateTitle(titleSeed),
    });

    if (isApprovalResume) await claimToolApproval(user.id, chat.id, messages[messages.length - 1]);

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
      ? await getRegenerationSnapshot(user.id, chat.id, latestUserMessage.id)
      : null;

    const mode = body.mode ?? "chat";
    const isChatMode = mode === "chat";
    const autoToolCandidates = isChatMode ? listAutoToolDescriptors("chat") : [];
    const autoToolIntent =
      isChatMode && !body.manualToolsOnly && !isApprovalResume && latestUserMessage?.text
        ? await detectAutoToolIntent({
            text: latestUserMessage.text,
            modelId,
            autoTools: autoToolCandidates,
          })
        : null;
    const toolsEnabled = isChatMode && (isApprovalResume || (!body.manualToolsOnly && autoToolIntent !== null));

    const relevantMemories = latestUserMessage?.text
      ? await getRelevantMemories({
          userId: user.id,
          query: latestUserMessage.text,
          limit: 6,
        })
      : [];

    if (latestUserMessage?.text) {
      const rememberPattern =
        /^(remember|记住|请记住)\s*[:：\-]?\s*(.+)$/i.exec(latestUserMessage.text.trim()) ??
        /^我的(.+?)是(.+)$/i.exec(latestUserMessage.text.trim());

      if (rememberPattern) {
        const memoryContent = rememberPattern[2]?.trim() ?? "";
        const keyHint = rememberPattern[1]?.trim() ?? "preference";

        if (memoryContent) {
          await saveMemory({
            userId: user.id,
            key: truncateTitle(keyHint || "user_memory", 40),
            value: memoryContent,
            score: 0.9,
          });
        }
      }
    }

    const systemPrompt = buildSystemPrompt(
      context.historyExcerpt || "No earlier messages omitted.",
      formatLongTermContext(relevantMemories),
      toolsEnabled,
    );
    let generationFailed = false;

    const result = streamText({
      model: getChatModel(modelId),
      system: systemPrompt,
      messages: modelMessages,
      abortSignal: req.signal,
      ...(toolsEnabled
        ? {
            tools: createChatToolSet(user.id, {
              modelId,
            }),
          }
        : {}),
      stopWhen: stepCountIs(5),
      onError: () => { generationFailed = true; },
      onFinish: async ({ model, finishReason }) => {
        if (finishReason === "error") generationFailed = true;
        console.info("chat.finish", {
          chatId: chat.id,
          modelId,
          model: model.modelId,
          trigger: body.trigger ?? "submit-message",
        });
      },
    });

    const streamError = (error: unknown) => JSON.stringify(apiErrorPayload(normalizeApiError(error, "聊天生成或保存失败，请重试或重新加载会话。")));
    const stream = result.toUIMessageStream({
      onError: (error) => streamError(error instanceof ApiError ? error : new ApiError({ code: "UPSTREAM_FAILED", message: "模型服务暂时不可用，请稍后重试。" })),
      originalMessages: messages,
      onFinish: async ({ responseMessage, isAborted }) => {
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

          if (toolItems.length > 0) {
            const memoryResults = await Promise.allSettled(
              toolItems.map((toolItem) =>
                persistToolMemory({
                  userId: user.id,
                  toolId: toolItem.toolName,
                  trigger: "auto",
                  state: toolItem.state,
                  input: toolItem.input,
                  output: toolItem.output,
                  assistantText,
                  modelId,
                }),
              ),
            );

            if (TOOL_DEBUG) {
              const decisions = memoryResults.map((result) =>
                result.status === "fulfilled" ? result.value.reason : "error",
              );
              console.info("chat.auto-tool.memory", {
                chatId: chat.id,
                toolCount: toolItems.length,
                decisions,
              });
            }
          }
        } catch (persistError) {
          throw normalizeApiError(persistError, "回答保存失败，请重新加载会话后重试。");
        }
      },
    });
    return createUIMessageStreamResponse({
      stream: createUIMessageStream({ execute: ({ writer }) => { writer.merge(stream); }, onError: streamError }),
      headers: { "x-chat-id": chat.id, "x-model-id": modelId, "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("/api/chat error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to generate chat response");
  }
}
