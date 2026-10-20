import { withModelCallSource } from "@/lib/models/call-context";
import { getChatModel } from "@/lib/ai/client";
import { getModelProvider } from "@/lib/models/providers";
import { t } from "@/lib/locale";
import { ApiError, apiErrorPayload, normalizeApiError } from "@/lib/server/api-error";
import { createChatToolSet } from "@/tools/catalog";
import type { ModelMessage } from "ai";
import { createUIMessageStream, createUIMessageStreamResponse, generateId, stepCountIs, streamText } from "ai";
import { persistChatResponse, type ChatPersistence } from "@/lib/chat/persistence";
import type { ChatRequest } from "@/lib/chat/request";
import type { DocumentDiagnostics } from "@/lib/documents/diagnostics";
import type { DocumentSource } from "@/lib/documents/types";
import { markDocumentCitations } from "@/lib/documents/references";
import { retainDataOperation } from "@/lib/server/data-operations";
import { addRunCost, finishRun, runStillAllowsStep, runStepCeiling } from "@/lib/agent/runs";
import { usageCost } from "@/lib/models/usage";
import { getModelPreferences } from "@/lib/models/preferences";
import { decodeDocumentScope } from "@/lib/documents/scope";
type TurnOutcome = { finishReason: unknown; generationFailed: boolean; aborted: boolean };

/**
 * How a turn ended, as the run record should read it.
 *
 * A stop the user asked for is a cancellation and says so; a provider failure is
 * a failure; anything else that ran out of steps is a plain success, because the
 * answer was delivered.
 */
function runStatusFor(outcome: TurnOutcome): "succeeded" | "failed" | "cancelled" {
  if (outcome.aborted) return "cancelled";
  if (outcome.generationFailed || outcome.finishReason === "error") return "failed";
  return "succeeded";
}

function runStopReason(outcome: TurnOutcome): string | undefined {
  if (outcome.aborted) return "stopped-by-user";
  if (outcome.generationFailed || outcome.finishReason === "error") return "provider-error";
  return undefined;
}

/**
 * What a turn cost, priced the same way the usage view prices it.
 *
 * Returned rather than thrown: a run record is bookkeeping, and failing to
 * price a finished turn must not fail the turn. Null means unknown, which the
 * run records as unknown rather than as free.
 */
async function costOfTurn(params: { usage: unknown; providerMetadata: unknown; modelRef: { providerId: string; modelId: string } }): Promise<number | null> {
  try {
    const preferences = await getModelPreferences();
    const rate = preferences.rates[`${params.modelRef.providerId}:${params.modelRef.modelId}`];
    return usageCost("chat", params.usage, params.providerMetadata, rate)?.costUsd ?? null;
  } catch {
    return null;
  }
}

export async function streamChatResponse(params: { input: ChatRequest; conversation: ChatPersistence; systemPrompt: string; modelMessages: ModelMessage[]; toolsEnabled: boolean; signal: AbortSignal; documentSources?: DocumentSource[]; documentDiagnostics?: DocumentDiagnostics; unavailableTools?: string[]; runId?: string | null; usesMemory?: boolean }) {
  const { input, conversation, systemPrompt, modelMessages, toolsEnabled, signal } = params;
  let answerText = "";
  const { modelRef, body, messages } = input;
  const { chat } = conversation;
  if (toolsEnabled && input.model?.supportsTools !== true) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: `${t("lib.models.chatPrefix")} ${modelRef.modelId} ${t("lib.models.chatNoTools")}` });
  }
  let generationFailed = false;
  const runId = params.runId ?? null;
  const runIds = [...new Set([...(conversation.previousRunIds ?? []), ...(runId ? [runId] : [])])];
  const stepCeiling = await runStepCeiling(runId);

  /**
   * Close the run, and account for what it spent. Both are best-effort: a
   * bookkeeping failure must not be the reason an answer fails.
   *
   * Closing follows message persistence, so a terminal run status never races
   * ahead of its saved details. The UI stream finish also fires on cancellation
   * when the generator's finish callback is skipped.
   */
  let runClosed = false;
  let completedTurn: { outcome: TurnOutcome; cost: number | null } | undefined;
  const closeRun = async (outcome: TurnOutcome, costUsd: number | null, reason?: string) => {
    if (!runId || runClosed) return;
    runClosed = true;
    await addRunCost(runId, costUsd).catch(() => null);
    await finishRun(runId, runStatusFor(outcome), reason ?? runStopReason(outcome)).catch(() => null);
  };

  // The provider decides how the workspace's reasoning preference is expressed
  // in its own request; a provider with no such notion contributes nothing and
  // the call goes out exactly as before.
  const providerOptions = getModelProvider(modelRef.providerId).reasoningOptions?.(input.reasoning);
  const tools = toolsEnabled ? await createChatToolSet({ modelRef, runId, toolIds: input.assistant?.tools, usesMemory: params.usesMemory !== false, documentCollections: decodeDocumentScope(input.conversationPolicy?.documentScope ?? chat.documentScope), documentRetrievalPolicy: input.assistant?.retrieval }) : undefined;
  const result = withModelCallSource("chat", () => streamText({
    model: getChatModel(modelRef),
    ...(providerOptions ? { providerOptions } : {}),
    maxRetries: 0,
    system: systemPrompt,
    messages: modelMessages,
    abortSignal: signal,
    onChunk: ({ chunk }) => { if (chunk.type === "text-delta") answerText += chunk.text; },
    ...(toolsEnabled
      ? {
        tools,
      }
      : {}),
    // An explicit stop condition also replaces the SDK's default one-step cap.
    // Historical bounded runs keep their recorded ceiling; new runs have none.
    stopWhen: [...(stepCeiling !== null ? [stepCountIs(stepCeiling)] : []), async () => !(await runStillAllowsStep(runId))],
    onError: () => { generationFailed = true; },
    onFinish: async ({ model, finishReason, totalUsage, response }) => {
      if (finishReason === "error") generationFailed = true;
      completedTurn = {
        outcome: { finishReason, generationFailed, aborted: signal.aborted },
        cost: await costOfTurn({
          usage: totalUsage,
          providerMetadata: (response as { providerMetadata?: unknown } | undefined)?.providerMetadata,
          modelRef,
        }),
      };
      console.info("chat.finish", {
        chatId: chat.id,
        modelId: modelRef.modelId,
        modelProvider: modelRef.providerId,
        model: model.modelId,
        trigger: body.trigger ?? "submit-message",
      });
    },
  }));

  const streamError = (error: unknown) => JSON.stringify(apiErrorPayload(normalizeApiError(error, t("lib.chat.generateFailed"))));
  const stream = result.toUIMessageStream({
    generateMessageId: generateId,
    onError: (error) => streamError(error instanceof ApiError ? error : new ApiError({ code: "UPSTREAM_FAILED", message: t("lib.chat.providerUnavailable") })),
    originalMessages: messages,
    messageMetadata: ({ part }) => part.type === "start" ? { documentSources: params.documentSources ?? [], documentDiagnostics: params.documentDiagnostics, runId: params.runId ?? undefined, runIds, modelLabel: `${input.modelRef.providerId}/${input.modelRef.modelId}` }
      : part.type === "finish" ? { documentSources: markDocumentCitations(params.documentSources ?? [], answerText), documentDiagnostics: params.documentDiagnostics, runId: params.runId ?? undefined, runIds, modelLabel: `${input.modelRef.providerId}/${input.modelRef.modelId}` } : undefined,
    onFinish: async ({ responseMessage, isAborted }) => {
      let persistenceFailed = false;
      try {
        await persistChatResponse({
          input, conversation, responseMessage, isAborted, generationFailed,
          documentSources: params.documentSources,
          documentDiagnostics: params.documentDiagnostics,
          unavailableTools: params.unavailableTools,
          runId: params.runId,
          usesMemory: params.usesMemory !== false,
        });
      } catch (error) {
        persistenceFailed = true;
        throw error;
      } finally {
        await closeRun({
          finishReason: completedTurn?.outcome.finishReason ?? null,
          generationFailed: generationFailed || persistenceFailed,
          aborted: isAborted || signal.aborted,
        }, completedTurn?.cost ?? null, persistenceFailed && !isAborted && !signal.aborted ? "persistence-error" : undefined);
      }
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
    headers: { "x-chat-id": chat.id, "x-model-id": modelRef.modelId, "Cache-Control": "no-store" },
  });

}
