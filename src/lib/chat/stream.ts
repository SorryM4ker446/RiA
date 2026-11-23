import { withModelCallSource, type CallSource } from "@/lib/models/call-context";
import { getChatModel } from "@/lib/ai/client";
import { getModelProvider } from "@/lib/models/providers";
import { getLatestUserMessage, getTextFromUIMessage } from "@/lib/ai/ui-message";
import { readMessageNotice } from "@/lib/chat/invocation-schema";
import { t } from "@/lib/locale";
import { ApiError, apiErrorPayload, normalizeApiError } from "@/lib/server/api-error";
import { createChatToolSet } from "@/tools/catalog";
import type { ModelMessage } from "ai";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { asSchema, createUIMessageStream, createUIMessageStreamResponse, generateId, smoothStream, stepCountIs, streamText, wrapLanguageModel, type TextStreamPart, type ToolSet, type UIMessage, type UIMessageChunk, type UIMessageStreamWriter } from "ai";
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
import { summarizeWithInternalAgent, type CompactionAllowance } from "./task-summary";
import { commitTurnFold, keepRestoredContext } from "./summary";
import { storedSummary } from "./model-context";
import { prepareStepImages, stepImageStats } from "./step-images";
import type { ConversationImageScope } from "@/lib/media/conversation-images";
import { EMPTY_SUMMARY_STATE, foldIntoState, recordedFacts, toolCallsIn, type SummaryState } from "./compaction-state";
import { restoredContext } from "./compaction-restore";
import { conversationWorkspace } from "@/lib/local-files/workspace";
import { externalToolIdPattern } from "@/lib/extensions/schema";
import { contextCalibration, conversationCalibration, recordContextCalibration } from "@/lib/models/context-calibration";
import { compactAfterTurn } from "./compaction";
import { planReminder } from "@/tools/definitions/update-plan";
import { hasUnseenGeneratedImage } from "@/tools/definitions/generate-image";
import { UNSEEN_IMAGE_REPLY_INSTRUCTION } from "@/lib/prompts";
import { pendingSubagentReports } from "@/lib/agents/subagents";
import { activeToolIds } from "@/tools/deferred";
import { createTurnFailureReader } from "./tool-failure";
import { createTerminalEvidenceReview } from "./terminal-evidence";
import { projectReasoning } from "@/lib/models/reasoning-replay";
/** OpenRouter passes along reasoning it cannot show as encrypted details. */
function hasEncryptedReasoning(metadata: unknown) {
  const details = (metadata as { openrouter?: { reasoning_details?: unknown } } | undefined)?.openrouter?.reasoning_details;
  return Array.isArray(details) && details.some(detail => (detail as { type?: unknown })?.type === "reasoning.encrypted");
}

/** Whether the answer ends asking the user to decide something first (an approval or a question). */
const awaitsDecision = (message: UIMessage) => message.parts.some(part => "state" in part && part.state === "approval-requested");

/** The SDK streams the parsed call before needsApproval binds its references and adds the verdict. */
function showBoundImageCalls() {
  type Part = TextStreamPart<ToolSet>;
  const pending = new Map<string, Extract<Part, { type: "tool-call" }>>();
  return new TransformStream<Part, Part>({
    transform(part, controller) {
      if (part.type === "tool-call" && part.toolName === "generateImage") {
        pending.set(part.toolCallId, part);
        return;
      }
      const id = part.type === "tool-approval-request" ? part.toolCall.toolCallId
        : part.type === "tool-result" || part.type === "tool-error" ? part.toolCallId : undefined;
      const call = id ? pending.get(id) : undefined;
      if (call) {
        pending.delete(call.toolCallId);
        controller.enqueue(part.type === "tool-approval-request" ? part.toolCall : call);
      }
      if (part.type === "finish-step" || part.type === "abort" || part.type === "error") {
        for (const unsettled of pending.values()) controller.enqueue(unsettled);
        pending.clear();
      }
      controller.enqueue(part);
    },
  });
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
  historyAttachments?: { count: number; bytes: number };
  approvalMessage?: UIMessage;
  partialHistory?: string;
  /** The messages this request sent, and whether they and the summary leave nothing out. */
  foldHistory?: { messages: { id: string; role: string }[]; complete: () => boolean; revision: number };
  onModelFold?: () => void;
  /** Whose calls these are: a turn the user is waiting on, or a task that started on its own and is held to the background limits. */
  callSource?: CallSource };
const LOOKUP_HINT = "Original messages, pictures and tool results stay saved. Use readConversationHistory for exact history or to look at saved picture pixels by imageIds.";
const streamError = (error: unknown) => JSON.stringify(apiErrorPayload(normalizeApiError(error, t("lib.chat.generateFailed"))));

/**
 * The response for one turn. Given `settleContext`, the response starts first and
 * tells the reader context is being organized, then the answer opens once it is
 * ready, so anything that refuses the answer from then on reads as a stream error.
 */
export async function streamChatResponse(params: Omit<ChatAnswer, "modelMessages"> & ({ modelMessages: ModelMessage[]; settleContext?: undefined } | { modelMessages?: undefined; settleContext: () => Promise<Pick<ChatAnswer, "modelMessages" | "partialHistory">> })) {
  const respond = (execute: (writer: UIMessageStreamWriter) => Promise<void>) => createUIMessageStreamResponse({
    stream: createUIMessageStream({ execute: ({ writer }) => execute(writer), onError: streamError }),
    headers: {
      "x-chat-id": params.conversation.chat.id,
      "x-model-id": params.input.modelRef.modelId,
      ...(params.runId ? { "x-chat-run-id": params.runId } : {}),
      "Cache-Control": "no-store",
    },
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
      const settled = await settleContext().catch(async (error: unknown) => {
        if (params.runId) await finishRun(params.runId, "cancelled", "stopped-by-user").catch(() => null);
        throw error;
      });
      writer.write({ type: "data-context-status", data: { organizing: false }, transient: true });
      await relay(await openChatAnswer({ ...params, ...settled }), writer);
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
  const { modelRef, body } = input;
  const messages = params.approvalMessage ? [...input.messages.slice(0, -1), params.approvalMessage] : input.messages;
  const { chat } = conversation;
  if (toolsEnabled && input.model?.supportsTools !== true) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: `${t("lib.models.chatPrefix")} ${modelRef.modelId} ${t("lib.models.chatNoTools")}` });
  }
  let generationFailed = false;
  let contextLimitFailed = false;
  let terminalEvidenceMissing = false;
  let skippedTool: string | undefined;
  // An approval resume continues the same turn, so its reasoning time adds up.
  const earlierThinking = input.isApprovalResume ? thinkingRecordSchema.safeParse((messages.at(-1)?.metadata as { thinking?: unknown } | undefined)?.thinking) : null;
  const thinkingClock = createThinkingClock(Date.now, earlierThinking?.success ? earlierThinking.data : undefined);
  const runId = params.runId ?? null;
  let runIds = [...new Set([...(conversation.previousRunIds ?? []), ...(runId ? [runId] : [])])];
  const stepCeiling = await runStepCeiling(runId);
  const terminalReview = createTerminalEvidenceReview();
  if (input.isApprovalResume) for (const part of messages.at(-1)?.parts ?? []) {
    if (part.type.startsWith("tool-") && "state" in part && part.state === "output-available") terminalReview.observe(part.type.slice(5), part.output);
  }

  // Keep unverified prose out of the stream and the saved answer. The model may still use tools to obtain evidence.
  const guardTerminalAnswer = () => {
    let pendingAtStart = false, awaitingApproval = false, incomplete = false;
    return new TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>({
      transform(chunk, controller) {
        if (chunk.type === "start-step") {
          pendingAtStart = terminalReview.pending().length > 0;
          awaitingApproval = false;
        }
        if (chunk.type === "tool-result" && !chunk.preliminary) terminalReview.observe(chunk.toolName, chunk.output, false);
        if (chunk.type === "tool-approval-request") awaitingApproval = true;
        if (chunk.type === "abort" || chunk.type === "error") incomplete = true;
        if (pendingAtStart && (chunk.type === "text-start" || chunk.type === "text-delta" || chunk.type === "text-end")) return;
        if (chunk.type === "finish" && !awaitingApproval && !incomplete && !signal.aborted && chunk.finishReason !== "error" && terminalReview.pending().length) {
          terminalEvidenceMissing = true;
          const id = generateId();
          const matches = terminalReview.matchedLines();
          const text = [t(terminalReview.reportedFailure() ? "chat.terminalEvidenceReportedFailure" : "chat.terminalEvidenceUnverified"), ...matches.map(line => `> ${line}`)].join("\n\n");
          controller.enqueue({ type: "text-start", id });
          controller.enqueue({ type: "text-delta", id, text });
          controller.enqueue({ type: "text-end", id });
        }
        controller.enqueue(chunk);
      },
    });
  };

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
  const unattended = params.callSource === "scheduled";
  const scheduled = unattended || conversation.scheduledApproval === true;
  let activeRef = modelRef;
  let activeSystem = systemPrompt;
  let reviewMessages: ModelMessage[] | undefined;
  const reviewUserText = input.latestUserMessage?.notice ? [] : messages.flatMap(message =>
    message.role === "user" && !readMessageNotice(message.metadata) ? [getTextFromUIMessage(message)] : []);
  const imageScope: ConversationImageScope | undefined = conversation.regenerationSnapshot
    ? { through: conversation.regenerationSnapshot.from, generated: new Set() } : undefined;
  const approvedImageCalls = new Set(input.isApprovalResume ? messages.at(-1)?.parts.flatMap(part =>
    part.type === "tool-generateImage" && "toolCallId" in part && "state" in part && part.state === "approval-responded" && part.approval?.approved
      ? [part.toolCallId] : []) : []);
  const tools = toolsEnabled ? await createChatToolSet({ modelRef, chatId: chat.id, runId, toolIds: input.assistant?.tools, usesMemory: params.usesMemory !== false, documentCollections: conversationCollections(input.conversationPolicy ?? chat), unattended, scheduled, compactionAllowance: params.compactionAllowance,
    activeModel: () => activeRef, reviewMessages: () => reviewMessages, reviewUserText, deferImageOutput: true, imageScope, approvedImageCalls,
    imageRequest: input.latestUserMessage ? { text: input.latestUserMessage.text, files: input.latestUserMessage.files } : undefined }) : undefined;
  // An assistant's tools can all be unavailable this turn, leaving none to send.
  const modelMessages = tools && !Object.keys(tools).length && !input.isApprovalResume ? withoutToolRecords(params.modelMessages) : params.modelMessages;
  const budget = contextBudget(input.model, preferences.contextLimits[modelRefKey(modelRef)]);
  let imageInput = input.model?.supportsImageInput === true;
  let imageBudget = budget.inputTokens;
  const projectStep = (stepMessages: ModelMessage[]) => prepareStepImages(projectReasoning(stepMessages, activeRef), { chatId: chat.id, supportsImages: imageInput, inputTokens: imageBudget, historyAttachments: params.historyAttachments, signal, imageScope });
  const toolDefinitions = tools ? await Promise.all(Object.entries(tools).map(async ([name, tool]) => tool.type === "provider"
    ? { type: "provider", name, id: tool.id, args: tool.args }
    : { type: "function", name, description: tool.description, inputSchema: await asSchema(tool.inputSchema).jsonSchema })) : undefined;
  // With extension tools loaded on demand, a step sends only the tools it offers; the context is measured on those.
  let activeTools = tools ? activeToolIds(tools, modelMessages) : null;
  const sentDefinitions = () => activeTools ? toolDefinitions?.filter(tool => activeTools!.includes(tool.name)) : toolDefinitions;
  const sentTools = () => tools && activeTools ? Object.fromEntries(Object.entries(tools).filter(([name]) => activeTools!.includes(name))) : tools;
  const calibration = await conversationCalibration(modelRef, messages);
  const contextReport = () => ({ ...stepContext.report, ...(params.compactionAllowance?.exhausted ? { compactionAllowanceExhausted: true } : {}) });
  // The conversation's one summary. A fold during this turn updates it, so the next
  // request, or this turn resuming after an approval, does not pay for the work again.
  const stored = await storedSummary(chat.id);
  let keptSummary = stored?.summary ?? null, summaryModel = "", foldState = stored?.state ?? EMPTY_SUMMARY_STATE;
  let foldWrites: Promise<unknown> = Promise.resolve();
  let restoredSeen: SummaryState["files"] = [];
  const stepContext = createStepContext({ budget, system: systemPrompt, tools: sentDefinitions(), signal, calibration, onModelFold: params.onModelFold,
    sizes: { skills: params.skillsPrompt, extensionTools: sentDefinitions()?.filter(tool => externalToolIdPattern.test(tool.name)) },
    handoff: stored ? { state: stored.summary, calls: stored.state.calls, restored: toolsEnabled ? stored.state.restored : undefined } : null,
    partialHistory: params.partialHistory,
    recorded: () => [recordedFacts(foldState), tools?.readConversationHistory ? LOOKUP_HINT : ""].filter(Boolean).join("\n"),
    summarize: async (records, previous, sent) => {
      const { state, modelRef: used } = await summarizeWithInternalAgent({ main: activeRef, records, previous, signal, allowance: params.compactionAllowance, request: getLatestUserMessage(messages)?.text,
        ...(sent && !stepImageStats(sent.messages).count && params.foldHistory?.complete() !== false ? { conversation: { system: activeSystem, tools: sentTools(), beforeSubmit: stepContext.authorizeRestoredContext, ...sent } } : {}) });
      summaryModel = `${used.providerId}:${used.modelId}`;
      return state;
    },
    ...(toolsEnabled ? {
      restoreWorkspace: async () => tools?.readProjectFile ? (await conversationWorkspace(chat.id))?.id ?? null : null,
      restoreAfterFold: async (inUse: Set<string>, workspaceId: string | null) => {
        const { text, seen } = await restoredContext({ state: foldState, inUse, signal, inputTokens: budget.inputTokens, allowSkills: true,
          workspaceId, allowFiles: workspaceId !== null });
        restoredSeen = seen;
        return text;
      },
      onRestored: restored => {
        const seen = restoredSeen;
        foldWrites = foldWrites.then(async () => { if (keptSummary) await keepRestoredContext({ chatId: chat.id, expected: keptSummary, restored, seen }); }).catch(() => console.error("chat.fold.save.failed"));
      },
    } : {}),
    onFold: fold => {
      foldState = foldIntoState(foldState, { toolCalls: toolCallsIn(fold.evidence) });
      // A later fold can build on excerpts from an earlier failed fold. Neither
      // may replace the persisted summary, even if the later model call succeeds.
      if (stepContext.report.degraded) return;
      const history = params.foldHistory?.messages ?? [];
      const firstKept = history.flatMap((message, index) => message.role === "user" ? [index] : [])[fold.coveredTurns];
      const coveredMessageIds = fold.coveredTurns > 0 && firstKept > 0 && params.foldHistory?.complete() ? history.slice(0, firstKept).map(message => message.id) : undefined;
      foldWrites = foldWrites.then(async () => {
        if (await commitTurnFold({ chatId: chat.id, historyRevision: params.foldHistory?.revision ?? chat.historyRevision, expected: keptSummary, summary: fold.state, change: { calls: fold.calls, toolCalls: toolCallsIn(fold.evidence) }, coveredMessageIds, modelId: summaryModel })) keptSummary = fold.state;
      }).catch(() => console.error("chat.fold.save.failed"));
    },
  });
  // A provider that refuses a step's input as over its window means the local
  // count was low. The step is compacted and sent again once; the SDK's own
  // messages stay whole, and later steps keep the folded state.
  // The model answering this request: the selected one, or the fallback once
  // it has taken over. Cost and calibration are recorded for it.
  const toPrompt = async (stepMessages: ModelMessage[]): Promise<LanguageModelV3Prompt> => convertToLanguageModelPrompt({ prompt: await standardizePrompt({ system: activeSystem, messages: stepMessages }), supportedUrls: await observed.supportedUrls, download: undefined });
  const observed: ReturnType<typeof getChatModel> = withModelCallSource(params.callSource ?? "chat", () => getChatModel(modelRef, {
    reasoning: input.reasoning,
    beforeSubmit: stepContext.authorizeRestoredContext,
    // Whichever model answers takes the request as it stands — same tools, same
    // messages — and the rest of it is planned for that model's own window: the
    // step it takes over is fitted again, and later steps compact against it.
    onSwitch: async ref => {
      activeRef = ref;
      const next = await modelInLibrary("chat", ref);
      const nextBudget = contextBudget(next, preferences.contextLimits[modelRefKey(ref)]);
      imageInput = next?.supportsImageInput === true;
      imageBudget = nextBudget.inputTokens;
      stepContext.retarget(nextBudget, await contextCalibration(ref));
      const projected = await projectStep(reviewMessages ?? modelMessages);
      activeSystem = activeSystem.replace(`\n${UNSEEN_IMAGE_REPLY_INSTRUCTION}`, "");
      if (hasUnseenGeneratedImage(projected)) activeSystem += `\n${UNSEEN_IMAGE_REPLY_INSTRUCTION}`;
      stepContext.setSystem(activeSystem);
      return toPrompt((await stepContext.prepare(projected)).messages);
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
    await stepContext.prepare(projectReasoning(modelMessages, activeRef));
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
  /**
   * Reports of background sub-agents taken during this turn, sent with each step from the one that took
   * them. They count as given once the answer is saved; a turn that fails, is stopped or stops for an
   * approval leaves them for the next turn (the resumed one takes them again).
   */
  const subagentReports: string[] = [];
  const heldReports: string[] = [];
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
      // The approval reviewer reads the actual conversation before app reminders are appended.
      reviewMessages = stepMessages;
      const projected = await projectStep(stepMessages);
      activeSystem = hasUnseenGeneratedImage(projected) ? `${systemPrompt}\n${UNSEEN_IMAGE_REPLY_INSTRUCTION}` : systemPrompt;
      if (terminalReview.hasCompleted()) activeSystem += "\nA command exited with code zero but its output was abbreviated. Before concluding it succeeded, use readTerminalLog to find a test or build outcome and review the rest of both non-empty streams. A filtered search or a log without a result summary does not establish success. If you cannot verify the result, leave it unverified.";
      stepContext.setSystem(activeSystem);
      // Tools loaded on demand in an earlier step are offered, in full, from this one.
      if (tools) {
        activeTools = activeToolIds(tools, stepMessages);
        const sent = sentDefinitions();
        stepContext.setTools(sent, sent?.filter(tool => externalToolIdPattern.test(tool.name)));
      }
      const prepared = await stepContext.prepare(projected);
      if (terminalReview.hasCompleted()) {
        terminalReview.clearVisibleEvidence();
        for (const message of prepared.messages) if (message.role === "tool") for (const part of message.content) {
          if (part.type === "tool-result" && part.toolName === "readTerminalLog" && part.output.type === "json") terminalReview.observe(part.toolName, part.output.value);
        }
      }
      thinkingClock.stepStarted();
      // Background sub-agents that ended since the last step: their reports join the turn here and stay
      // with every later step of it. A later turn reads them with checkSubagents.
      if (tools && "runSubagent" in tools) {
        // A check for a specific agent may have already returned its report in a tool result.
        for (const part of stepMessages.at(-1)?.content ?? []) {
          if (typeof part === "string" || part.type !== "tool-result" || part.toolName !== "checkSubagents" || part.output.type !== "json") continue;
          const result = part.output.value as { id?: string; background?: boolean; status?: string } | null;
          if (result?.id && result.background && result.status !== "running") heldReports.push(result.id);
        }
        const reports = await pendingSubagentReports(chat.id, heldReports).catch(() => ({ ids: [] as string[], text: "", titles: [] }));
        if (reports.text) { subagentReports.push(reports.text); heldReports.push(...reports.ids); }
      }
      // A reminder about the checklist rides on this step only, after everything else, so the prompt before it stays as it was.
      const reminder = tools && "updatePlan" in tools ? planReminder(stepMessages) : null;
      const messages = [...prepared.messages, ...[...subagentReports, ...(reminder ? [reminder] : [])].map(text => ({ role: "user" as const, content: [{ type: "text" as const, text }] }))];
      return { ...prepared, messages, system: activeSystem, ...(stepNumber === 0 && params.chosenTool ? { activeTools: [params.chosenTool] } : activeTools ? { activeTools } : {}) };
    },
    onStepFinish: ({ usage, toolCalls, stepNumber, reasoning, providerMetadata }) => {
      stepContext.observeUsage(usage.inputTokens);
      thinkingClock.stepFinished({ reasoning, hiddenReasoning: (usage.outputTokenDetails?.reasoningTokens ?? 0) > 0 || hasEncryptedReasoning(providerMetadata) });
      if (stepNumber === 0 && params.chosenTool && !toolCalls.some(call => call.toolName === params.chosenTool)) skippedTool = params.chosenTool;
    },
    abortSignal: signal,
    onChunk: ({ chunk }) => {
      if (chunk.type === "reasoning-delta") thinkingClock.reasoning();
      else if (chunk.type === "text-delta" || chunk.type === "tool-call" || chunk.type === "tool-input-start") thinkingClock.output();
    },
    // Providers send text in uneven bursts. Released a word at a time (a
    // character or two in Chinese), a few milliseconds apart, the answer reads
    // as steady typing rather than jumps; faster than a model writes, so it
    // does not hold the answer back.
    experimental_transform: [
      showBoundImageCalls,
      guardTerminalAnswer,
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
      : part.type === "finish" ? { ...answeredAt(), runId: params.runId ?? undefined, runIds, modelLabel: `${input.modelRef.providerId}/${input.modelRef.modelId}`, contextBudget: contextReport(), ...(terminalEvidenceMissing ? { terminalEvidenceUnverified: true } : {}), ...(skippedTool ? { skippedTool } : {}), ...(thinkingClock.report() ? { thinking: thinkingClock.report() } : {}) } : undefined,
    onFinish: async ({ responseMessage, isAborted }) => {
      let persistenceFailed = false;
      try {
        await persistChatResponse({
          // Ended by a stop, whether or not the stream got as far as saying so.
          input, conversation, responseMessage, isAborted: isAborted || signal.aborted, generationFailed: generationFailed || terminalEvidenceMissing, skippedTool, thinking: thinkingClock.report(),
          answeredBy: !awaitsDecision(responseMessage) && completedTurn?.outcome.finishReason === "stop" ? activeRef : undefined,
          unavailableTools: params.unavailableTools, scheduled,
          runId: params.runId,
          contextReport: contextReport(),
            heldReports: !generationFailed && !terminalEvidenceMissing && !isAborted && !signal.aborted && !awaitsDecision(responseMessage) ? heldReports : [],
        });
      } catch (error) {
        persistenceFailed = true;
        throw error;
      } finally {
        // A planning cache: failing to update it must not affect the turn.
        await recordContextCalibration(activeRef, stepContext.observedRatio()).catch(() => console.error("chat.calibration.record.failed"));
        await closeRun({
          finishReason: completedTurn?.outcome.finishReason ?? null,
          generationFailed: generationFailed || terminalEvidenceMissing || persistenceFailed,
          aborted: isAborted || signal.aborted,
        }, completedTurn?.cost ?? null, persistenceFailed && !isAborted && !signal.aborted ? "persistence-error" : contextLimitFailed ? "context-limit" : terminalEvidenceMissing ? "terminal-evidence-incomplete" : undefined);
      }
      await foldWrites;
      // Runs after the answer is saved, and nothing here waits for it.
      if (!isAborted && !signal.aborted && !persistenceFailed && (body.mode ?? "chat") === "chat") void compactAfterTurn({ chatId: chat.id, modelRef });
    },
  });
}
