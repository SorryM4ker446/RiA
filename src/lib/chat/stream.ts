import { getChatModel } from "@/lib/ai/client";
import { ApiError, apiErrorPayload, normalizeApiError } from "@/lib/server/api-error";
import { createChatToolSet } from "@/tools/catalog";
import type { ModelMessage } from "ai";
import { createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText } from "ai";
import { persistChatResponse, type ChatPersistence } from "@/lib/chat/persistence";
import type { ChatRequest } from "@/lib/chat/request";
import type { DocumentSource } from "@/lib/documents/types";
import { retainDataOperation } from "@/lib/server/data-operations";
export function streamChatResponse(params: { input: ChatRequest; conversation: ChatPersistence; userId: string; systemPrompt: string; modelMessages: ModelMessage[]; toolsEnabled: boolean; signal: AbortSignal; documentSources?: DocumentSource[] }) {
  const { input, conversation, userId, systemPrompt, modelMessages, toolsEnabled, signal } = params;
  const { modelId, body, messages } = input;
  const { chat } = conversation;
  let generationFailed = false;

  const result = streamText({
    model: getChatModel(modelId),
    maxRetries: 0,
    system: systemPrompt,
    messages: modelMessages,
    abortSignal: signal,
    ...(toolsEnabled
      ? {
        tools: createChatToolSet(userId, {
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
    messageMetadata: ({ part }) => part.type === "start" ? { documentSources: params.documentSources ?? [] } : undefined,
    onFinish: async ({ responseMessage, isAborted }) => {
      await persistChatResponse({ input, conversation, userId, responseMessage, isAborted, generationFailed, documentSources: params.documentSources });
    },
  });
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({ execute: async ({ writer }) => {
      // The SDK continues consuming after the HTTP reader disconnects. Hold
      // the restore gate until that consumer and message persistence finish.
      const release = retainDataOperation(), reader = stream.getReader();
      try { for (;;) { const item = await reader.read(); if (item.done) break; writer.write(item.value); } }
      finally { reader.releaseLock(); release(); }
    }, onError: streamError }),
    headers: { "x-chat-id": chat.id, "x-model-id": modelId, "Cache-Control": "no-store" },
  });

}
