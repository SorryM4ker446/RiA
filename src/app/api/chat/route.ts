import { google } from "@ai-sdk/google";
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { NextRequest } from "next/server";
import { DEFAULT_MODEL } from "@/config/model";
import { getOrCreateRequestUser } from "@/lib/auth/request-user";
import { getLatestUserText, truncateTitle } from "@/lib/ai/ui-message";
import { createChat, getChat, getRecentChatMessages, saveChatMessage } from "@/lib/chat/store";
import { getRelevantMemories, saveMemory } from "@/lib/memory/store";
import { checkRateLimit } from "@/lib/server/rate-limit";
import { db } from "@/db";
import { createChatTools } from "@/tools/registry";

type ChatRequestBody = {
  id?: string;
  chatId?: string;
  conversationId?: string;
  messageId?: string;
  trigger?: "submit-message" | "regenerate-message" | "resume-stream";
  messages?: UIMessage[];
};

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

function buildSystemPrompt(shortTermContext: string, longTermMemoryContext: string): string {
  return [
    "You are a private AI assistant. Be concise, practical, and helpful.",
    "Ask a short follow-up question when user intent is ambiguous.",
    "When user asks for project knowledge lookup, use searchKnowledge.",
    "When user asks to create a todo/task, use createTask and confirm the result.",
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
    if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) {
      return Response.json(
        {
          error:
            "GOOGLE_GENERATIVE_AI_API_KEY is not configured. Set it in .env and restart the dev server before chatting.",
        },
        { status: 500 },
      );
    }

    const body = (await req.json()) as ChatRequestBody;
    const messages = Array.isArray(body.messages) ? body.messages : [];

    if (messages.length === 0) {
      return Response.json({ error: "messages is required" }, { status: 400 });
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

    const latestUserMessage = getLatestUserText(messages);
    const titleSeed = latestUserMessage?.text || "New Chat";
    const chat = await getOrCreateChat({
      requestedChatId: body.chatId ?? body.conversationId ?? body.id,
      userId: user.id,
      fallbackTitle: truncateTitle(titleSeed),
    });

    if (latestUserMessage?.text) {
      await saveChatMessage({
        chatId: chat.id,
        role: "user",
        content: latestUserMessage.text,
        status: "success",
        clientMessageId: latestUserMessage.id,
      });
    }

    const shortTermMessagesRaw = await getRecentChatMessages(chat.id, 10);
    const shortTermMessages = [...shortTermMessagesRaw]
      .reverse()
      .map((message) => ({ role: message.role, content: message.content }));

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
    );
    const modelMessages = await convertToModelMessages(messages);
    const tools = createChatTools(user.id);

    const result = streamText({
      model: google(DEFAULT_MODEL),
      system: systemPrompt,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(5),
      onFinish: async ({ text, model }) => {
        const assistantText = text.trim();
        if (!assistantText) return;

        await saveChatMessage({
          chatId: chat.id,
          role: "assistant",
          content: assistantText,
          status: "success",
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

        console.info("chat.finish", {
          chatId: chat.id,
          model: model.modelId,
          trigger: body.trigger ?? "submit-message",
        });
      },
    });

    return result.toUIMessageStreamResponse({
      originalMessages: messages,
      headers: {
        "x-chat-id": chat.id,
      },
    });
  } catch (error) {
    console.error("/api/chat error", error);
    return Response.json({ error: "Failed to generate chat response" }, { status: 500 });
  }
}
