import { withModelCallSource } from "@/lib/models/call-context";
import { getChatModel } from "@/lib/ai/client";
import { getModelProvider } from "@/lib/models/providers";
import { t } from "@/lib/locale";
import { ApiError, apiErrorPayload, normalizeApiError } from "@/lib/server/api-error";
import { createChatToolSet } from "@/tools/catalog";
import type { ModelMessage } from "ai";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { asSchema, createUIMessageStream, createUIMessageStreamResponse, generateId, stepCountIs, streamText, wrapLanguageModel } from "ai";
import { convertToLanguageModelPrompt, standardizePrompt } from "ai/internal";
import { isContextOverflow } from "@/lib/models/context-overflow";
import { claimChatApproval, persistChatResponse, type ChatPersistence } from "@/lib/chat/persistence";
import type { ChatRequest } from "@/lib/chat/request";
import type { DocumentDiagnostics } from "@/lib/documents/diagnostics";
import type { DocumentSource } from "@/lib/documents/types";
import { markDocumentCitations } from "@/lib/documents/references";
import { retainDataOperation } from "@/lib/server/data-operations";
import { addRunCost, finishRun, runStillAllowsStep, runStepCeiling } from "@/lib/agent/runs";
import { usageCost } from "@/lib/models/usage";
import { getModelPreferences, modelInLibrary } from "@/lib/models/preferences";
import { decodeDocumentScope } from "@/lib/documents/scope";
import { contextBudget } from "@/lib/models/context-budget";
import { modelRefKey } from "@/lib/models/preferences-schema";
import { createStepContext } from "./step-context";
import { summarizeTaskState, type CompactionAllowance } from "./task-summary";
import { contextCalibration, recordContextCalibration } from "@/lib/models/context-calibration";
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
  if (outcome.generationFailed || outcome.finishReason === "error" || outcome.finishReason === "length") return "failed";
  return "succeeded";
}

function runStopReason(outcome: TurnOutcome): string | undefined {
  if (outcome.aborted) return "stopped-by-user";
  if (outcome.finishReason === "length") return "output-limit";
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

export async function streamChatResponse(params: { input: ChatRequest; conversation: ChatPersistence; systemPrompt: string; modelMessages: ModelMessage[]; toolsEnabled: boolean; signal: AbortSignal; documentSources?: DocumentSource[]; documentDiagnostics?: DocumentDiagnostics; unavailableTools?: string[]; runId?: string | null; usesMemory?: boolean; compactionAllowance?: CompactionAllowance }) {
  const { input, conversation, systemPrompt, modelMessages, toolsEnabled, signal } = params;
  let answerText = "";
  const { modelRef, body, messages } = input;
  const { chat } = conversation;
  if (toolsEnabled && input.model?.supportsTools !== true) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: `${t("lib.models.chatPrefix")} ${modelRef.modelId} ${t("lib.models.chatNoTools")}` });
  }
  let generationFailed = false;
  let contextLimitFailed = false;
  const runId = params.runId ?? null;
  let runIds = [...new Set([...(conversation.previousRunIds ?? []), ...(runId ? [runId] : [])])];
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
  const preferences = await getModelPreferences();
  // The fallback model answers with the same reasoning preference. Provider
  // options are keyed by provider, so each model reads only its own.
  const fallbackRef = preferences.chat.fallback;
  const reasoningFor = (ref: { providerId: string }) => getModelProvider(ref.providerId as typeof modelRef.providerId).reasoningOptions?.(input.reasoning);
  const providerOptions = fallbackRef && fallbackRef.providerId !== modelRef.providerId
    ? (() => { const merged = { ...(reasoningFor(fallbackRef) ?? {}), ...(reasoningFor(modelRef) ?? {}) }; return Object.keys(merged).length ? merged : undefined; })()
    : reasoningFor(modelRef);
  const tools = toolsEnabled ? await createChatToolSet({ modelRef, chatId: chat.id, runId, toolIds: input.assistant?.tools, usesMemory: params.usesMemory !== false, documentCollections: decodeDocumentScope(input.conversationPolicy?.documentScope ?? chat.documentScope), documentRetrievalPolicy: input.assistant?.retrieval }) : undefined;
  const budget = contextBudget(input.model, preferences.contextLimits[modelRefKey(modelRef)]);
  const toolDefinitions = tools ? await Promise.all(Object.entries(tools).map(async ([name, tool]) => tool.type === "provider"
    ? { type: "provider", name, id: tool.id, args: tool.args }
    : { type: "function", name, description: tool.description, inputSchema: await asSchema(tool.inputSchema).jsonSchema })) : undefined;
  const calibration = await contextCalibration(modelRef);
  const contextReport = () => ({ ...stepContext.report, ...(params.compactionAllowance?.exhausted ? { compactionAllowanceExhausted: true } : {}) });
  const stepContext = createStepContext({ budget, system: systemPrompt, tools: toolDefinitions, signal, calibration,
    summarize: (records, previous, focus) => summarizeTaskState({ modelRef: activeRef, records, previous, signal, allowance: params.compactionAllowance, focus }),
  });
  // A provider that refuses a step's input as over its window means the local
  // count was low. The step is compacted and sent again once; the SDK's own
  // messages stay whole, and later steps keep the folded state.
  // The model answering this request: the selected one, or the fallback once
  // it has taken over. Cost and calibration are recorded for it.
  let activeRef = modelRef;
  const toPrompt = async (stepMessages: ModelMessage[]): Promise<LanguageModelV3Prompt> => convertToLanguageModelPrompt({ prompt: await standardizePrompt({ system: systemPrompt, messages: stepMessages }), supportedUrls: await observed.supportedUrls, download: undefined });
  const observed: ReturnType<typeof getChatModel> = withModelCallSource("chat", () => getChatModel(modelRef, {
    // Whichever model answers takes the request as it stands — same tools, same
    // messages — and the rest of it is planned for that model's own window: the
    // step it takes over is fitted again, and later steps compact against it.
    onSwitch: async ref => {
      activeRef = ref;
      stepContext.retarget(contextBudget(await modelInLibrary("chat", ref), preferences.contextLimits[modelRefKey(ref)]), await contextCalibration(ref));
      return toPrompt(await stepContext.refit());
    },
  }));
  const model = wrapLanguageModel({ model: observed, middleware: { specificationVersion: "v3",
    async wrapStream({ doStream, params: call }) {
      try { return await doStream(); }
      catch (error) {
        if (!isContextOverflow(error) || signal.aborted) throw error;
        return observed.doStream({ ...call, prompt: await toPrompt(await stepContext.recoverFromOverflow()) });
      }
    },
  } });
  try {
    await stepContext.prepare(modelMessages);
    signal.throwIfAborted();
    if (input.isApprovalResume && conversation.approvalDeferred) {
      const previous = await claimChatApproval(chat.id, messages.at(-1)!);
      conversation.previousRunIds = previous;
      runIds = [...new Set([...previous, ...(runId ? [runId] : [])])];
    }
  } catch (error) {
    await closeRun({ finishReason: "error", generationFailed: true, aborted: signal.aborted }, null,
      error instanceof ApiError && error.code === "CONTEXT_LIMIT" ? "context-limit" : "preflight-error");
    throw error;
  }
  const result = withModelCallSource("chat", () => streamText({
    model,
    ...(providerOptions ? { providerOptions } : {}),
    maxRetries: 0,
    system: systemPrompt,
    messages: modelMessages,
    // Each step's output cap is set where every call is admitted, from that
    // step's own input; see requestOutputCap.
    prepareStep: ({ messages: stepMessages }) => stepContext.prepare(stepMessages),
    onStepFinish: ({ usage }) => stepContext.observeUsage(usage.inputTokens),
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
    onError: ({ error }) => { generationFailed = true; contextLimitFailed = error instanceof ApiError && error.code === "CONTEXT_LIMIT"; },
    onFinish: async ({ model, finishReason, totalUsage, response }) => {
      if (finishReason === "error" || finishReason === "length") generationFailed = true;
      completedTurn = {
        outcome: { finishReason, generationFailed, aborted: signal.aborted },
        cost: await costOfTurn({
          usage: totalUsage,
          providerMetadata: (response as { providerMetadata?: unknown } | undefined)?.providerMetadata,
          modelRef: activeRef,
        }),
      };
      console.info("chat.finish", {
        chatId: chat.id,
        modelId: activeRef.modelId,
        modelProvider: activeRef.providerId,
        fallback: activeRef !== modelRef,
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
      : part.type === "finish" ? { documentSources: markDocumentCitations(params.documentSources ?? [], answerText), documentDiagnostics: params.documentDiagnostics, runId: params.runId ?? undefined, runIds, modelLabel: `${input.modelRef.providerId}/${input.modelRef.modelId}`, contextBudget: contextReport() } : undefined,
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
          contextReport: contextReport(),
        });
      } catch (error) {
        persistenceFailed = true;
        throw error;
      } finally {
        // A planning cache: failing to update it must not affect the turn.
        await recordContextCalibration(activeRef, stepContext.observedRatio()).catch(() => console.error("chat.calibration.record.failed"));
        await closeRun({
          finishReason: completedTurn?.outcome.finishReason ?? null,
          generationFailed: generationFailed || persistenceFailed,
          aborted: isAborted || signal.aborted,
        }, completedTurn?.cost ?? null, persistenceFailed && !isAborted && !signal.aborted ? "persistence-error" : contextLimitFailed ? "context-limit" : undefined);
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
