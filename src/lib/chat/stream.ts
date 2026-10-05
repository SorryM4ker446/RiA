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
import type { DocumentSource } from "@/lib/documents/types";
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

export async function streamChatResponse(params: { input: ChatRequest; conversation: ChatPersistence; systemPrompt: string; modelMessages: ModelMessage[]; toolsEnabled: boolean; signal: AbortSignal; documentSources?: DocumentSource[]; unavailableTools?: string[]; runId?: string | null; usesMemory?: boolean }) {
  const { input, conversation, systemPrompt, modelMessages, toolsEnabled, signal } = params;
  const { modelRef, body, messages } = input;
  const { chat } = conversation;
  if (toolsEnabled && input.model?.supportsTools !== true) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: `${t("lib.models.chatPrefix")} ${modelRef.modelId} ${t("lib.models.chatNoTools")}` });
  }
  let generationFailed = false;
  const runId = params.runId ?? null;
  // Read once, before the first request: the ceiling is a property of the run,
  // and asking the database between every step would put a query in the hot path.
  const stepCeiling = await runStepCeiling(runId);

  /**
   * Close the run, and account for what it spent. Both are best-effort: a
   * bookkeeping failure must not be the reason an answer fails.
   *
   * Called from two places because a turn can end without ever reaching the
   * generator's own `onFinish`. When the user stops a turn, the SDK rejects the
   * flush before it reaches that callback, so a run closed only from there stayed
   * `running` forever and its cost was never recorded — and the cancellation
   * status the mapping below can express was unreachable. The message stream's
   * finish does fire on a stop, so it closes what the generator never reached.
   * The flag makes the second call a no-op, which matters because a turn that
   * finishes normally reaches both.
   */
  let runClosed = false;
  const closeRun = async (outcome: TurnOutcome, costUsd: number | null) => {
    if (!runId || runClosed) return;
    runClosed = true;
    await addRunCost(runId, costUsd).catch(() => null);
    await finishRun(runId, runStatusFor(outcome), runStopReason(outcome)).catch(() => null);
  };

  // The provider decides how the workspace's reasoning preference is expressed
  // in its own request; a provider with no such notion contributes nothing and
  // the call goes out exactly as before.
  const providerOptions = getModelProvider(modelRef.providerId).reasoningOptions?.(input.reasoning);
  const tools = toolsEnabled ? await createChatToolSet({ modelRef, runId, usesMemory: params.usesMemory !== false, documentCollections: decodeDocumentScope(chat.documentScope) }) : undefined;
  const result = withModelCallSource("chat", () => streamText({
    model: getChatModel(modelRef),
    ...(providerOptions ? { providerOptions } : {}),
    maxRetries: 0,
    system: systemPrompt,
    messages: modelMessages,
    abortSignal: signal,
    ...(toolsEnabled
      ? {
        tools,
      }
      : {}),
    /*
     * Two conditions, and the second is the one that was missing.
     *
     * The step ceiling is the run row's own budget, so the limit the user was
     * shown is the limit that binds; the absolute ceiling is a backstop, not the
     * rule. The second condition asks the run whether it still has room: without
     * it a stopped or over-budget run stopped taking tool steps but kept issuing
     * provider requests, because the refusal came back as an ordinary tool result
     * the SDK counted as a completed step.
     */
    stopWhen: [stepCountIs(stepCeiling), async () => !(await runStillAllowsStep(runId))],
    onError: () => { generationFailed = true; },
    onFinish: async ({ model, finishReason, totalUsage, response }) => {
      if (finishReason === "error") generationFailed = true;
      await closeRun(
        { finishReason, generationFailed, aborted: signal.aborted },
        await costOfTurn({
          usage: totalUsage,
          providerMetadata: (response as { providerMetadata?: unknown } | undefined)?.providerMetadata,
          modelRef,
        }),
      );
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
    messageMetadata: ({ part }) => part.type === "start" ? { documentSources: params.documentSources ?? [] } : undefined,
    onFinish: async ({ responseMessage, isAborted }) => {
      // A stopped turn never reaches the generator's finish, so this is what
      // closes it. The cost is unknown rather than zero: the provider never
      // reported usage for a turn that was cut off, and recording a turn the
      // user stopped as free would let the cost budget be spent by stopping.
      await closeRun({ finishReason: null, generationFailed, aborted: isAborted }, null);
      await persistChatResponse({
        input, conversation, responseMessage, isAborted, generationFailed,
        documentSources: params.documentSources,
        unavailableTools: params.unavailableTools,
        usesMemory: params.usesMemory !== false,
      });
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
