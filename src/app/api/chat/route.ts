import { convertToModelMessages, generateObject, stepCountIs, streamText, type ToolSet, type UIMessage } from "ai";
import { NextRequest } from "next/server";
import { z } from "zod";
import { chatModelSupportsImageInput, resolveModelId } from "@/config/model";
import { getChatModel } from "@/lib/ai/client";
import { getOrCreateRequestUser } from "@/lib/auth/request-user";
import {
  decodePersistedAssistantToolMessage,
  decodePersistedUserMessage,
  encodePersistedAssistantToolMessage,
  encodePersistedUserMessage,
  getTextFromUIMessage,
  type PersistedAssistantToolItem,
  getLatestUserMessage,
  truncateTitle,
} from "@/lib/ai/ui-message";
import { createChat, getChat, getRecentChatMessages, saveChatMessage } from "@/lib/chat/store";
import { getRelevantMemories, saveMemory } from "@/lib/memory/store";
import { checkRateLimit } from "@/lib/server/rate-limit";
import { setupServerProxy } from "@/lib/server/proxy";
import { db } from "@/db";
import { createChatTools } from "@/tools/registry";

type ChatRequestBody = {
  id?: string;
  chatId?: string;
  conversationId?: string;
  messageId?: string;
  modelId?: string;
  mode?: "chat" | "image" | "video";
  manualToolsOnly?: boolean;
  trigger?: "submit-message" | "regenerate-message" | "resume-stream";
  messages?: UIMessage[];
};

type AutoToolIntent = "searchKnowledge" | "createTask" | null;
const autoToolIntentSchema = z.object({
  intent: z.enum(["searchKnowledge", "createTask", "none"]),
  shouldUseToolNow: z.boolean(),
  userRequestMode: z.enum(["explicit-action", "topic-question", "ambiguous"]),
  expectedBenefit: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().optional(),
});

const IMAGE_MESSAGE_PREFIX = "__IMAGE_RESULT__:";
const VIDEO_MESSAGE_PREFIX = "__VIDEO_RESULT__:";

function normalizeStoredMessageContent(content: string): string {
  const parsedAssistantToolMessage = decodePersistedAssistantToolMessage(content);
  if (parsedAssistantToolMessage) {
    const toolNames = Array.from(
      new Set(parsedAssistantToolMessage.tools.map((tool) => tool.toolName).filter(Boolean)),
    );
    const toolLabel = toolNames.length > 0 ? toolNames.join(", ") : "unknown_tool";
    const successCount = parsedAssistantToolMessage.tools.filter((item) => item.state === "output-available").length;
    return `assistant used tools in previous turn: ${toolLabel} (successful calls: ${successCount})`;
  }

  const parsedUser = decodePersistedUserMessage(content);
  if (parsedUser) {
    const text = parsedUser.text || "(image input)";
    return parsedUser.files.length > 0
      ? `${text} [attached images: ${parsedUser.files.length}]`
      : text;
  }

  if (content.startsWith(IMAGE_MESSAGE_PREFIX)) {
    try {
      const raw = content.slice(IMAGE_MESSAGE_PREFIX.length);
      const parsed = JSON.parse(raw) as { text?: string };
      return parsed.text?.trim() || "Image generated";
    } catch {
      return "Image generated";
    }
  }

  if (content.startsWith(VIDEO_MESSAGE_PREFIX)) {
    try {
      const raw = content.slice(VIDEO_MESSAGE_PREFIX.length);
      const parsed = JSON.parse(raw) as { text?: string };
      return parsed.text?.trim() || "Video generated";
    } catch {
      return "Video generated";
    }
  }

  return content;
}

function formatShortTermContext(
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>,
): string {
  if (messages.length === 0) return "No short-term context yet.";
  return messages.map((message) => `- ${message.role}: ${message.content}`).join("\n");
}

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
    }));
}

function buildSystemPrompt(
  shortTermContext: string,
  longTermMemoryContext: string,
  toolsEnabled: boolean,
  autoToolIntent: AutoToolIntent,
): string {
  const toolInstruction =
    toolsEnabled && autoToolIntent
      ? [
          "Use searchKnowledge only when the latest user message requires project-knowledge retrieval.",
          "Use createTask only when the latest user message clearly asks for task/todo creation.",
          "Tool decision must be independent per turn, based only on the latest user message.",
          `Only one tool is allowed for this turn: ${autoToolIntent}.`,
          "When tool output is available, answer in Chinese with this order: factual points from tool results first, then your integrated reasoning.",
          "If tools are used in this turn, clearly state your factual basis comes from this turn's tool output.",
          "Do not fabricate facts that are not in tool results. If evidence is limited, state uncertainty clearly.",
        ]
      : [
          "Tools are disabled for this request.",
          "Do not emit any tool-call markup (such as <function_calls> or XML/JSON tool directives).",
          "No tools were run in this turn.",
          "Even if previous turns used tools, do not present this turn as a fresh search.",
          "Do not claim project retrieval happened in this turn.",
          "When describing your basis, use current conversation context, memory, and general reasoning only.",
          "Answer directly from available context; if information is insufficient, state uncertainty and ask one short clarification question.",
        ];

  return [
    "You are a private AI assistant. Be concise, practical, and helpful.",
    "Ask a short follow-up question when user intent is ambiguous.",
    ...toolInstruction,
    "",
    "[Short-Term Context]",
    shortTermContext,
    "",
    "[Long-Term Memory]",
    longTermMemoryContext,
    "",
    "[Tooling Policy]",
    "If tools are available, use them only when they improve correctness.",
  ].join("\n");
}

async function detectAutoToolIntent(params: {
  text: string;
  modelId: ReturnType<typeof resolveModelId>;
}): Promise<AutoToolIntent> {
  const input = params.text.trim();
  if (!input) return null;

  try {
    const { object } = await generateObject({
      model: getChatModel(params.modelId),
      schema: autoToolIntentSchema,
      system: [
        "You are a tool-intent classifier for a chat assistant.",
        "Decide tool intent from ONLY the latest user message.",
        "Valid outputs: searchKnowledge, createTask, none.",
        "Only enable tools when the user explicitly asks to execute a retrieval/task action now.",
        "Do not trigger tools for ordinary topic follow-up questions that can be answered directly.",
        "Set userRequestMode=explicit-action only when the user is clearly asking the assistant to run a tool-like action.",
        "For implicit, broad, or ambiguous asks, set shouldUseToolNow=false and prefer none.",
        "Use high confidence only when the action request is unambiguous.",
      ].join(" "),
      prompt: `Latest user message:\n${input}`,
    });

    console.info("auto-tool intent result", {
      intent: object.intent,
      shouldUseToolNow: object.shouldUseToolNow,
      userRequestMode: object.userRequestMode,
      confidence: object.confidence ?? null,
      expectedBenefit: object.expectedBenefit ?? null,
    });

    if (object.intent === "none") {
      return null;
    }

    if (!object.shouldUseToolNow) {
      return null;
    }

    if (object.userRequestMode !== "explicit-action") {
      return null;
    }

    if (typeof object.confidence === "number" && object.confidence < 0.82) {
      return null;
    }

    if (typeof object.expectedBenefit === "number" && object.expectedBenefit < 0.7) {
      return null;
    }

    return object.intent;
  } catch (error) {
    console.warn("auto-tool intent classification failed", error);
    return null;
  }
}

function createIntentScopedTools(userId: string, intent: Exclude<AutoToolIntent, null>): ToolSet {
  const allTools = createChatTools(userId);
  if (intent === "searchKnowledge") {
    return { searchKnowledge: allTools.searchKnowledge };
  }
  return { createTask: allTools.createTask };
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

function buildModelInputMessages(messages: UIMessage[], toolsEnabled: boolean): UIMessage[] {
  if (toolsEnabled) {
    return messages;
  }

  // In non-tool turns, keep user messages as the primary signal to avoid assistant-style carry-over.
  return messages.filter((message) => message.role === "user");
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
      throw new Error("Forbidden chat access.");
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
    setupServerProxy();

    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      return Response.json(
        {
          error:
            "OPENROUTER_API_KEY is not configured. Set it in .env and restart the dev server before chatting.",
        },
        { status: 500 },
      );
    }

    const body = (await req.json()) as ChatRequestBody;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const modelId = resolveModelId(body.modelId);
    const latestUserMessage = getLatestUserMessage(messages);

    if (messages.length === 0) {
      return Response.json({ error: "messages is required" }, { status: 400 });
    }

    if (latestUserMessage?.files.length && !chatModelSupportsImageInput(modelId)) {
      return Response.json(
        { error: `当前聊天模型 ${modelId} 不支持图片输入，请切换到支持视觉的模型。` },
        { status: 400 },
      );
    }

    const user = await getOrCreateRequestUser(req);
    const rateLimit = checkRateLimit({
      key: `chat:${user.id}`,
      limit: 30,
      windowMs: 60_000,
    });

    if (!rateLimit.allowed) {
      return Response.json(
        {
          error: "Too many chat requests. Please wait a moment and try again.",
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateLimit.retryAfterSeconds),
            "X-RateLimit-Remaining": String(rateLimit.remaining),
          },
        },
      );
    }

    const titleSeed = latestUserMessage?.text || "New Chat";
    const chat = await getOrCreateChat({
      requestedChatId: body.chatId ?? body.conversationId ?? body.id,
      userId: user.id,
      fallbackTitle: truncateTitle(titleSeed),
    });

    if (latestUserMessage) {
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

    const isChatMode = body.mode === "chat";
    const autoToolIntent =
      isChatMode && latestUserMessage?.text
        ? await detectAutoToolIntent({
            text: latestUserMessage.text,
            modelId,
          })
        : null;
    const toolsEnabled = isChatMode && !body.manualToolsOnly && autoToolIntent !== null;

    const shortTermMessagesRaw = await getRecentChatMessages(chat.id, 10);
    const shortTermMessages = [...shortTermMessagesRaw]
      .reverse()
      .flatMap((message) => {
        const parsedAssistantToolMessage =
          message.role === "assistant" ? decodePersistedAssistantToolMessage(message.content) : null;

        // Keep user context + structured tool history; skip plain assistant prose in short-term context.
        if (message.role === "assistant" && !parsedAssistantToolMessage) {
          return [];
        }

        const content = normalizeStoredMessageContent(message.content);
        if (!content.trim()) {
          return [];
        }
        return [{ role: message.role, content }];
      });

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
      formatShortTermContext(shortTermMessages),
      formatLongTermContext(relevantMemories),
      toolsEnabled,
      autoToolIntent,
    );
    const effectiveMessages = chatModelSupportsImageInput(modelId)
      ? messages
      : stripFilePartsForTextOnlyModel(messages);
    const modelInputMessages = buildModelInputMessages(effectiveMessages, toolsEnabled);
    const modelMessages = await convertToModelMessages(modelInputMessages);

    const result = streamText({
      model: getChatModel(modelId),
      system: systemPrompt,
      messages: modelMessages,
      ...(toolsEnabled && autoToolIntent
        ? { tools: createIntentScopedTools(user.id, autoToolIntent) }
        : {}),
      stopWhen: stepCountIs(5),
      onFinish: async ({ model }) => {
        console.info("chat.finish", {
          chatId: chat.id,
          modelId,
          model: model.modelId,
          trigger: body.trigger ?? "submit-message",
        });
      },
    });

    return result.toUIMessageStreamResponse({
      originalMessages: messages,
      onFinish: async ({ responseMessage, isAborted }) => {
        if (isAborted) return;

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

          await saveChatMessage({
            chatId: chat.id,
            role: "assistant",
            content,
            status: "success",
            clientMessageId: responseMessage.id,
          });

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
        } catch (persistError) {
          console.error("chat.persist.onFinish error", persistError);
        }
      },
      headers: {
        "x-chat-id": chat.id,
        "x-model-id": modelId,
      },
    });
  } catch (error) {
    console.error("/api/chat error", error);
    return Response.json({ error: "Failed to generate chat response" }, { status: 500 });
  }
}
