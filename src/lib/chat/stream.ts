import { withModelCallSource, type CallSource } from "@/lib/models/call-context";
import { getChatModel } from "@/lib/ai/client";
import { getModelProvider } from "@/lib/models/providers";
import { getLatestUserMessage } from "@/lib/ai/ui-message";
import { t } from "@/lib/locale";
import { ApiError, apiErrorPayload, normalizeApiError } from "@/lib/server/api-error";
import { createChatToolSet } from "@/tools/catalog";
import type { ModelMessage } from "ai";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { asSchema, createUIMessageStream, createUIMessageStreamResponse, generateId, smoothStream, stepCountIs, streamText, wrapLanguageModel, type TextStreamPart, type ToolSet, type UIMessageChunk, type UIMessageStreamWriter } from "ai";
import { convertToLanguageModelPrompt, standardizePrompt } from "ai/internal";
import { isContextOverflow } from "@/lib/models/context-overflow";
import { claimChatApproval, persistChatResponse, type ChatPersistence } from "@/lib/chat/persistence";
import type { ChatRequest } from "@/lib/chat/request";
import { retainDataOperation } from "@/lib/server/data-operations";
import { addRunCost, finishRun, runStillAllowsStep, runStepCeiling } from "@/lib/agent/runs";
import { usageCost } from "@/lib/models/usage";
import { getModelPreferences, modelInLibrary } from "@/lib/models/preferences";
import { conversationCollections } from "@/lib/conversations/document-scope";
import { contextBudget } from "@/lib/models/context-budget";
import { modelRefKey } from "@/lib/models/preferences-schema";
import { createStepContext, withoutToolRecords } from "./step-context";
import { createThinkingClock, thinkingRecordSchema } from "./thinking";
import { summarizeWithAuxiliary, type CompactionAllowance } from "./task-summary";
import { commitTurnFold, keepRestoredContext } from "./summary";
import { storedSummary } from "./model-context";
import { EMPTY_SUMMARY_STATE, foldIntoState, recordedFacts, toolCallsIn, type SummaryState } from "./compaction-state";
import { restoredContext } from "./compaction-restore";
import { conversationWorkspace } from "@/lib/local-files/workspace";
import { externalToolIdPattern } from "@/lib/extensions/schema";
import { templateAllowsTool } from "@/tools/template-access";
import { contextCalibration, conversationCalibration, recordContextCalibration } from "@/lib/models/context-calibration";
import { compactAfterTurn } from "./compaction";
import { createTurnFailureReader } from "./tool-failure";
/** OpenRouter passes along reasoning it cannot show as encrypted details. */
function hasEncryptedReasoning(metadata: unknown) {
  const details = (metadata as { openrouter?: { reasoning_details?: unknown } } | undefined)?.openrouter?.reasoning_details;
  return Array.isArray(details) && details.some(detail => (detail as { type?: unknown })?.type === "reasoning.encrypted");
}

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

type ChatAnswer = { input: ChatRequest; conversation: ChatPersistence; systemPrompt: string; modelMessages: ModelMessage[]; toolsEnabled: boolean; signal: AbortSignal; unavailableTools?: string[]; runId?: string | null; usesMemory?: boolean; compactionAllowance?: CompactionAllowance; chosenTool?: string | null;
  /** The part of the system prompt listing skills, which the usage view counts separately. */
  skillsPrompt?: string;
  /** The messages this request sent, and whether they and the summary leave nothing out. */
  foldHistory?: { messages: { id: string; role: string }[]; complete: () => boolean };
  onModelFold?: () => void;
  /** Whose calls these are: a turn the user is waiting on, or a task that started on its own and is held to the background limits. */
  callSource?: CallSource };
const LOOKUP_HINT = "The original messages and tool results stay saved: readConversationHistory finds them by toolCallId, messageId or text.";
const streamError = (error: unknown) => JSON.stringify(apiErrorPayload(normalizeApiError(error, t("lib.chat.generateFailed"))));

/**
 * The response for one turn. Given `settleContext`, the response starts first and
 * tells the reader context is being organized, then the answer opens once it is
 * ready, so anything that refuses the answer from then on reads as a stream error.
 */
export async function streamChatResponse(params: Omit<ChatAnswer, "modelMessages"> & ({ modelMessages: ModelMessage[]; settleContext?: undefined } | { modelMessages?: undefined; settleContext: () => Promise<ModelMessage[]> })) {
  const respond = (execute: (writer: UIMessageStreamWriter) => Promise<void>) => createUIMessageStreamResponse({
    stream: createUIMessageStream({ execute: ({ writer }) => execute(writer), onError: streamError }),
    headers: { "x-chat-id": params.conversation.chat.id, "x-model-id": params.input.modelRef.modelId, "Cache-Control": "no-store" },
  });
  const relay = async (stream: ReadableStream<UIMessageChunk>, writer: UIMessageStreamWriter) => {
    // The SDK continues consuming after the HTTP reader disconnects. Hold
    // the restore gate until that consumer and message persistence finish.
    const release = retainDataOperation(), reader = stream.getReader();
    try { for (;;) { const item = await reader.read(); if (item.done) break; writer.write(item.value); } }
    finally { reader.releaseLock(); release(); }
  };
  if (!params.settleContext) {
    // A request that must fold before it can start stops holding the response back,
    // so the reader is told why the answer is taking a while.
    let announce!: () => void;
    const folding = new Promise<"folding">(resolve => { announce = () => resolve("folding"); });
    const opening = openChatAnswer({ ...params, modelMessages: params.modelMessages, onModelFold: () => announce() });
    const first = await Promise.race([opening, folding]);
    if (first !== "folding") return respond(writer => relay(first, writer));
    return respond(async writer => {
      const release = retainDataOperation();
      try {
        writer.write({ type: "data-context-status", data: { organizing: true }, transient: true });
        const stream = await opening;
        writer.write({ type: "data-context-status", data: { organizing: false }, transient: true });
        await relay(stream, writer);
      } finally { release(); }
    });
  }
  const { settleContext } = params;
  return respond(async writer => {
    const release = retainDataOperation();
    try {
      writer.write({ type: "data-context-status", data: { organizing: true }, transient: true });
      const modelMessages = await settleContext().catch(async (error: unknown) => {
        if (params.runId) await finishRun(params.runId, "cancelled", "stopped-by-user").catch(() => null);
        throw error;
      });
      writer.write({ type: "data-context-status", data: { organizing: false }, transient: true });
      await relay(await openChatAnswer({ ...params, modelMessages }), writer);
    } finally { release(); }
  });
}

/**
 * Ends the answer the moment the turn is stopped. The SDK notices a stop only
 * when it reads more from the provider, and the smoothing above writes out what
 * it already holds before it reads again: a provider that sent much of the
 * answer at once would keep the stopped answer going until all of that was
 * written. Here the stop ends it with the SDK's own abort, so the answer is
 * saved as stopped, where it was, as it would be had the provider been slower.
 */
function endsWhenStopped(signal: AbortSignal) {
  return () => {
    let stop = () => {};
    return new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
      start(controller) {
        stop = () => {
          try {
            controller.enqueue({ type: "abort", ...(signal.reason !== undefined ? { reason: String(signal.reason) } : {}) } as TextStreamPart<ToolSet>);
            controller.terminate();
          } catch { /* Already ended on its own. */ }
        };
        if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
      },
      transform(chunk, controller) { controller.enqueue(chunk); },
      flush() { signal.removeEventListener("abort", stop); },
    });
  };
}

async function openChatAnswer(params: ChatAnswer) {
  const { input, conversation, systemPrompt, toolsEnabled, signal } = params;
  let answerText = "", lastStepText = "";
  const { modelRef, body, messages } = input;
  const { chat } = conversation;
  if (toolsEnabled && input.model?.supportsTools !== true) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: `${t("lib.models.chatPrefix")} ${modelRef.modelId} ${t("lib.models.chatNoTools")}` });
  }
  let generationFailed = false;
  let contextLimitFailed = false;
  let skippedTool: string | undefined;
  // An approval resume continues the same turn, so its reasoning time adds up.
  const earlierThinking = input.isApprovalResume ? thinkingRecordSchema.safeParse((messages.at(-1)?.metadata as { thinking?: unknown } | undefined)?.thinking) : null;
  const thinkingClock = createThinkingClock(Date.now, earlierThinking?.success ? earlierThinking.data : undefined);
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

  const preferences = await getModelPreferences();
  const tools = toolsEnabled ? await createChatToolSet({ modelRef, chatId: chat.id, runId, toolIds: input.assistant?.tools, usesMemory: params.usesMemory !== false, documentCollections: conversationCollections(input.conversationPolicy ?? chat) }) : undefined;
  // An assistant's tools can all be unavailable this turn, leaving none to send.
  const modelMessages = tools && !Object.keys(tools).length && !input.isApprovalResume ? withoutToolRecords(params.modelMessages) : params.modelMessages;
  const budget = contextBudget(input.model, preferences.contextLimits[modelRefKey(modelRef)]);
  const toolDefinitions = tools ? await Promise.all(Object.entries(tools).map(async ([name, tool]) => tool.type === "provider"
    ? { type: "provider", name, id: tool.id, args: tool.args }
    : { type: "function", name, description: tool.description, inputSchema: await asSchema(tool.inputSchema).jsonSchema })) : undefined;
  const calibration = await conversationCalibration(modelRef, messages);
  const contextReport = () => ({ ...stepContext.report, ...(params.compactionAllowance?.exhausted ? { compactionAllowanceExhausted: true } : {}) });
  // The conversation's one summary. A fold during this turn updates it, so the next
  // request, or this turn resuming after an approval, does not pay for the work again.
  const stored = await storedSummary(chat.id);
  let keptSummary = stored?.summary ?? null, summaryModel = "", foldState = stored?.state ?? EMPTY_SUMMARY_STATE;
  let foldWrites: Promise<unknown> = Promise.resolve();
  let restoredSeen: SummaryState["files"] = [];
  const stepContext = createStepContext({ budget, system: systemPrompt, tools: toolDefinitions, signal, calibration, onModelFold: params.onModelFold,
    sizes: { skills: params.skillsPrompt, extensionTools: toolDefinitions?.filter(tool => externalToolIdPattern.test(tool.name)) },
    handoff: stored ? { state: stored.summary, calls: stored.state.calls, ...(stored.state.restored === undefined ? {} : { restored: stored.state.restored }) } : null,
    recorded: () => [recordedFacts(foldState), tools?.readConversationHistory ? LOOKUP_HINT : ""].filter(Boolean).join("\n"),
    summarize: async (records, previous, sent) => {
      const { state, modelRef: used } = await summarizeWithAuxiliary({ main: activeRef, records, previous, signal, allowance: params.compactionAllowance, request: getLatestUserMessage(messages)?.text,
        ...(sent ? { conversation: { system: systemPrompt, tools, ...sent } } : {}) });
      summaryModel = `${used.providerId}:${used.modelId}`;
      return state;
    },
    ...(toolsEnabled ? {
      restoreAfterFold: async (inUse: Set<string>) => {
        const { text, seen } = await restoredContext({ state: foldState, inUse, signal, inputTokens: budget.inputTokens, allowSkills: true,
          workspaceId: (await conversationWorkspace(chat.id))?.id ?? null, allowFiles: !input.assistant || templateAllowsTool(input.assistant.tools, "readProjectFile") });
        restoredSeen = seen;
        return text;
      },
      onRestored: (restored: string) => {
        const seen = restoredSeen;
        foldWrites = foldWrites.then(async () => { if (keptSummary) await keepRestoredContext({ chatId: chat.id, expected: keptSummary, restored, seen }); }).catch(() => console.error("chat.fold.save.failed"));
      },
    } : {}),
    onFold: fold => {
      foldState = foldIntoState(foldState, { toolCalls: toolCallsIn(fold.evidence) });
      // Labelled excerpts stand in for this turn only; the stored summary stays as it was.
      if (fold.degraded) return;
      const history = params.foldHistory?.messages ?? [];
      const firstKept = history.flatMap((message, index) => message.role === "user" ? [index] : [])[fold.coveredTurns];
      const upToMessageId = fold.coveredTurns > 0 && firstKept > 0 && params.foldHistory?.complete() ? history[firstKept - 1].id : undefined;
      foldWrites = foldWrites.then(async () => {
        if (await commitTurnFold({ chatId: chat.id, expected: keptSummary, summary: fold.state, change: { calls: fold.calls, toolCalls: toolCallsIn(fold.evidence) }, upToMessageId, modelId: summaryModel })) keptSummary = fold.state;
      }).catch(() => console.error("chat.fold.save.failed"));
    },
  });
  // A provider that refuses a step's input as over its window means the local
  // count was low. The step is compacted and sent again once; the SDK's own
  // messages stay whole, and later steps keep the folded state.
  // The model answering this request: the selected one, or the fallback once
  // it has taken over. Cost and calibration are recorded for it.
  let activeRef = modelRef;
  const toPrompt = async (stepMessages: ModelMessage[]): Promise<LanguageModelV3Prompt> => convertToLanguageModelPrompt({ prompt: await standardizePrompt({ system: systemPrompt, messages: stepMessages }), supportedUrls: await observed.supportedUrls, download: undefined });
  const observed: ReturnType<typeof getChatModel> = withModelCallSource(params.callSource ?? "chat", () => getChatModel(modelRef, {
    reasoning: input.reasoning,
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
  const result = withModelCallSource(params.callSource ?? "chat", () => streamText({
    model,
    maxRetries: 0,
    system: systemPrompt,
    messages: modelMessages,
    // Each step's output cap is set where every call is admitted, from that
    // step's own input; see requestOutputCap.
    // The tool the user chose is the only one on offer at first, which needs no
    // provider's support for forcing a call and cannot be refused for reasoning.
    // The model may still answer without it; the turn records that when it does.
    prepareStep: async ({ messages: stepMessages, stepNumber }) => {
      const prepared = await stepContext.prepare(stepMessages);
      thinkingClock.stepStarted();
      return { ...prepared, ...(stepNumber === 0 && params.chosenTool ? { activeTools: [params.chosenTool] } : {}) };
    },
    onStepFinish: ({ usage, toolCalls, stepNumber, reasoning, providerMetadata, text }) => {
      stepContext.observeUsage(usage.inputTokens);
      lastStepText = text;
      thinkingClock.stepFinished({ reasoning, hiddenReasoning: (usage.outputTokenDetails?.reasoningTokens ?? 0) > 0 || hasEncryptedReasoning(providerMetadata) });
      if (stepNumber === 0 && params.chosenTool && !toolCalls.some(call => call.toolName === params.chosenTool)) skippedTool = params.chosenTool;
    },
    abortSignal: signal,
    onChunk: ({ chunk }) => {
      if (chunk.type === "text-delta") answerText += chunk.text;
      if (chunk.type === "reasoning-delta") thinkingClock.reasoning();
      else if (chunk.type === "text-delta" || chunk.type === "tool-call" || chunk.type === "tool-input-start") thinkingClock.output();
    },
    // Providers send text in uneven bursts. Released a word at a time (a
    // character or two in Chinese), a few milliseconds apart, the answer reads
    // as steady typing rather than jumps; faster than a model writes, so it
    // does not hold the answer back.
    experimental_transform: [
      smoothStream({ delayInMs: 6, chunking: new Intl.Segmenter(undefined, { granularity: "word" }) }),
      endsWhenStopped(signal),
    ],
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

  // Sent at the start too, for an answer stopped before it finishes. A resumed turn
  // keeps the time of the message it continues, as its stored row does.
  const answeredAt = () => input.isApprovalResume ? {} : { createdAt: new Date().toISOString() };
  const readFailure = createTurnFailureReader(() => { try { return getModelProvider(activeRef.providerId).displayName; } catch { return undefined; } });
  return result.toUIMessageStream({
    generateMessageId: generateId,
    onError: (error) => streamError(readFailure(error)),
    originalMessages: messages,
    messageMetadata: ({ part }) => part.type === "start" ? { ...answeredAt(), runId: params.runId ?? undefined, runIds, modelLabel: `${input.modelRef.providerId}/${input.modelRef.modelId}` }
      : part.type === "finish" ? { ...answeredAt(), runId: params.runId ?? undefined, runIds, modelLabel: `${input.modelRef.providerId}/${input.modelRef.modelId}`, contextBudget: contextReport(), ...(skippedTool ? { skippedTool } : {}), ...(thinkingClock.report() ? { thinking: thinkingClock.report() } : {}) } : undefined,
    onFinish: async ({ responseMessage, isAborted }) => {
      let persistenceFailed = false;
      try {
        await persistChatResponse({
          // Ended by a stop, whether or not the stream got as far as saying so.
          input, conversation, responseMessage, isAborted: isAborted || signal.aborted, generationFailed, skippedTool, thinking: thinkingClock.report(),
          unavailableTools: params.unavailableTools,
          runId: params.runId,
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
      await foldWrites;
      // Runs after the answer is saved, and nothing here waits for it.
      if (!isAborted && !signal.aborted && !persistenceFailed && (body.mode ?? "chat") === "chat") void compactAfterTurn({ chatId: chat.id, modelRef,
        conversation: () => {
          if (activeRef !== modelRef) return null;
          const sent = stepContext.conversationSent(lastStepText);
          return sent ? { system: systemPrompt, tools, ...sent } : null;
        } });
    },
  });
}
