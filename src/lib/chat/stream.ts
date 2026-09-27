import { getChatModel } from "@/lib/ai/client";
import { t } from "@/lib/locale";
import { ApiError, apiErrorPayload, normalizeApiError } from "@/lib/server/api-error";
import { createChatToolSet } from "@/tools/catalog";
import type { ModelMessage } from "ai";
import { createUIMessageStream, createUIMessageStreamResponse, stepCountIs, streamText } from "ai";
import { persistChatResponse, type ChatPersistence } from "@/lib/chat/persistence";
import type { ChatRequest } from "@/lib/chat/request";
import type { DocumentSource } from "@/lib/documents/types";
import { retainDataOperation } from "@/lib/server/data-operations";
export function streamChatResponse(params: { input: ChatRequest; conversation: ChatPersistence; systemPrompt: string; modelMessages: ModelMessage[]; toolsEnabled: boolean; signal: AbortSignal; documentSources?: DocumentSource[] }) {
  const { input, conversation, systemPrompt, modelMessages, toolsEnabled, signal } = params;
  const { modelId, body, messages } = input;
  const { chat } = conversation;
  if (toolsEnabled && input.model?.supportsTools !== true) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: `${t("lib.models.chatPrefix")} ${modelId} ${t("lib.models.chatNoTools")}` });
  }
  let generationFailed = false;

  const result = streamText({
    model: getChatModel(modelId),
    maxRetries: 0,
    system: systemPrompt,
    messages: modelMessages,
    abortSignal: signal,
    ...(toolsEnabled
      ? {
        tools: createChatToolSet({
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

  const streamError = (error: unknown) => JSON.stringify(apiErrorPayload(normalizeApiError(error, t("lib.chat.generateFailed"))));
  const stream = result.toUIMessageStream({
    onError: (error) => streamError(error instanceof ApiError ? error : new ApiError({ code: "UPSTREAM_FAILED", message: t("lib.chat.providerUnavailable") })),
    originalMessages: messages,
    messageMetadata: ({ part }) => part.type === "start" ? { documentSources: params.documentSources ?? [] } : undefined,
    onFinish: async ({ responseMessage, isAborted }) => {
      await persistChatResponse({ input, conversation, responseMessage, isAborted, generationFailed, documentSources: params.documentSources });
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
