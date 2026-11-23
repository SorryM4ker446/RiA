import { buildRequestContext, buildSystemPrompt, filesSeen, formatCurrentTime, formatKnowledgeScope, keepRequestContext, prepareModelContext, storedSummary, withRequestTexts } from "@/lib/chat/model-context";
import { changedFiles, restoreReferencedFiles } from "@/lib/chat/compaction-restore";
import { memoryForRequest, readMemoryDocument } from "@/lib/memory/document";
import { prepareChatPersistence } from "@/lib/chat/persistence";
import type { ChatRequest } from "@/lib/chat/request";
import { streamChatResponse } from "@/lib/chat/stream";
import { startRun } from "@/lib/agent/runs";
import type { ModelRef } from "@/lib/models/preferences-schema";
import { getModelPreferences } from "@/lib/models/preferences";
import { contextBudget } from "@/lib/models/context-budget";
import { modelRefKey } from "@/lib/models/preferences-schema";
import { getModelProvider } from "@/lib/models/providers";
import { compactForRequest } from "@/lib/chat/compaction";
import type { IncompleteSummary } from "@/lib/chat/summary";
import type { PartialHistory } from "@/lib/chat/step-context";
import { createCompactionAllowance } from "@/lib/chat/task-summary";
import { t, tf } from "@/lib/locale";
import { ApiError } from "@/lib/server/api-error";
import { setupServerProxy } from "@/lib/server/proxy";
import { listPublicToolCatalog } from "@/tools/catalog";
import { templateAllowsTool } from "@/tools/template-access";
import { formatAssistantInstructions } from "@/lib/assistants/schema";
import { formatPluginSkills } from "@/lib/plugins/store";
import { conversationCollections } from "@/lib/conversations/document-scope";
import { conversationWorkspace, formatWorkspaceContext } from "@/lib/local-files/workspace";
import { resolveInvocation } from "@/lib/chat/invocation";
import { db } from "@/db";
import { takeBackgroundCommandContext } from "@/lib/terminal/runtime";
import { takeUndoContext } from "@/lib/checkpoints/undo";
import type { CallSource } from "@/lib/models/call-context";
import { recentConversationImages } from "@/lib/media/conversation-images";

/**
 * One turn of a conversation: the request is saved, the model answers with its
 * tools, and the answer is saved as it ends. The response streams the answer.
 *
 * Nothing here depends on who is asking. The page calls it for a message the
 * user sent; a task calls it for the prompt it was given, and reads the stream
 * to its end itself. `signal` is whatever stops the turn: the page going away,
 * or the task being stopped.
 */
/** deliverSubagents: background sub-agent reports the new message carries, given to the conversation only if it is saved. */
export async function answerChatRequest(input: ChatRequest, signal: AbortSignal, options: { callSource?: CallSource; requestNote?: string; deliverSubagents?: string[] } = {}): Promise<Response> {
  const { body, modelRef, latestUserMessage } = input;
  // Checked against the provider the chosen model actually belongs to. Naming
  // OpenRouter here refused every DeepSeek-only install before it could say so,
  // which is the one thing a user who only ever added a DeepSeek model needs
  // to be able to run.
  const provider = getModelProvider(modelRef.providerId);
  if (!provider.isConfigured()) {
    throw new ApiError({ code: "CONFIGURATION_ERROR", message: tf("lib.chat.providerKeyMissing", { provider: provider.displayName }), details: { fix: "apiKeys" } });
  }
  setupServerProxy();

  const { context, modelMessages, historyAttachments, approvalMessage } = await prepareModelContext(input, signal);
  const mode = body.mode ?? "chat";
  const isChatMode = mode === "chat";
  const canUseTools = isChatMode && input.model?.supportsTools === true;
  // The chat model decides for itself whether a tool helps, so tools stay
  // attached for the whole turn. Selection follows the task instructions
  // and each tool's modelDescription, not from a second LLM call that would
  // have to guess from the latest message alone.
  const toolsEnabled = canUseTools && (!input.assistant || input.assistant.tools.length > 0);
  // Checked before the message is saved: a refused message goes back to the
  // composer, and saving it too would leave a copy behind for every retry. An
  // approval resume continues a turn that already honoured its choice.
  const invocation = latestUserMessage?.invocation && !input.isApprovalResume
    ? await resolveInvocation(latestUserMessage.invocation, { allowedToolIds: input.assistant?.tools, modelSupportsTools: toolsEnabled, modelRef })
    : null;
  const conversation = await prepareChatPersistence(input, { deferApproval: true, deliverSubagents: options.deliverSubagents });
  const unavailableStatuses = await unavailableChatTools(input.assistant?.tools, canUseTools, modelRef);
  const unavailableTools = unavailableStatuses.map(tool => tool.id);

  // The switch is about long-term memory: MEMORY.md and the tool that writes it. It is
  // not a promise that nothing is kept: the messages, uploads and usage stay as they
  // otherwise would, and the knowledge base is still there to draw on.
  const usesMemory = !(input.conversationPolicy?.ephemeral ?? conversation.chat.ephemeral);
  // One allowance per request covers older-turn summaries and in-stream compaction.
  const preferences = await getModelPreferences();
  const compactionAllowance = createCompactionAllowance(preferences.callLimits.compactionCallsPerTurn);
  const beforeSummary = await storedSummary(conversation.chat.id);
  const beforeGap = context.historyGap(beforeSummary?.coveredIds);
  // A small uncovered interval can travel with the request. If only excerpts
  // fit, read it from storage for the summary before asking the chat model.
  const awaitsSummary = beforeGap.missing && (!beforeSummary || beforeGap.incomplete);

  // The system prompt carries only rules that stay the same across turns. The
  // optional tools configured away this turn are named there, so the model
  // can answer honestly about what it could not check.
  const skillsPrompt = await formatPluginSkills({ onDemand: toolsEnabled });
  // The memory rule only where its tool is offered: memory on, and a template that allows tools at all.
  const memoryOffered = toolsEnabled && usesMemory && (!input.assistant || templateAllowsTool(input.assistant.tools, "extractMemory"));
  const systemPrompt = buildSystemPrompt(toolsEnabled, unavailableStatuses, preferences.persona, { memory: memoryOffered })
    + formatAssistantInstructions(input.assistant)
    + (toolsEnabled && !unavailableTools.includes("searchKnowledge") ? formatKnowledgeScope(conversationCollections(input.conversationPolicy ?? conversation.chat)) : "")
    + skillsPrompt;
  // Which folder this conversation works in is restated on every request, so
  // a switch made between turns is what the model acts on next.
  const workspace = toolsEnabled && (!input.assistant || input.assistant.tools.includes("runTerminalCommand"))
    ? formatWorkspaceContext(await conversationWorkspace(conversation.chat.id), await db.directoryGrant.count({ where: { revokedAt: null } }) > 0)
    : "";
  // Whether the summary and the messages sent leave nothing out between them. A
  // fold during the turn may only move the summary's end if they do.
  let historyComplete = !beforeGap.missing;
  // This turn's reference data travels with the user's message.
  const withEarlierTurns = async (incomplete?: IncompleteSummary) => {
    const stored = await storedSummary(conversation.chat.id);
    const gap = context.historyGap(stored?.coveredIds);
    historyComplete = !gap.missing;
    const excerpt = gap.text + (gap.incomplete ? (toolsEnabled
      ? "\nIf you need an exact earlier constraint, decision or result, verify it with readConversationHistory before answering or acting."
      : "\nIf an exact earlier constraint, decision or result is needed and missing, ask the user to clarify it before proceeding.") : "");
    const canReadFiles = toolsEnabled && (!input.assistant || templateAllowsTool(input.assistant.tools, "readProjectFile"));
    const workspaceGrant = canReadFiles && (!input.isApprovalResume || incomplete) ? (await conversationWorkspace(conversation.chat.id))?.id : null;
    let partialHistory: PartialHistory | undefined;
    if (incomplete && gap.incomplete) {
      const current = await db.chat.findUnique({ where: { id: conversation.chat.id }, select: { historyRevision: true, summaryRevision: true, summary: true, summaryUpToMessageId: true } });
      if (current?.historyRevision === incomplete.historyRevision) {
        const valid = current.summaryRevision === current.historyRevision;
        if ((valid ? current.summary : null) === incomplete.previousSummary
          && (valid ? current.summaryUpToMessageId : null) === incomplete.previousBoundary) {
          const request = latestUserMessage?.text;
          const files = workspaceGrant && request && incomplete.files.length
            ? await restoreReferencedFiles({ files: incomplete.files, workspaceId: workspaceGrant, request, signal,
              inputTokens: contextBudget(input.model, preferences.contextLimits[modelRefKey(modelRef)]).inputTokens })
            : "";
          partialHistory = { draft: incomplete.draft, ...(files && workspaceGrant ? { files: { text: files, workspaceId: workspaceGrant } } : {}) };
        }
      }
    }
    // A continuation repeats the saved request context. A shorter window may
    // now leave out more history, so supply the uncovered interval if needed.
    if (input.isApprovalResume) return { modelMessages: withRequestTexts(modelMessages, excerpt ? [excerpt] : []), partialHistory };
    const fileChanges = workspaceGrant ? await changedFiles({ seen: filesSeen(stored?.state, context.messages, workspaceGrant), grantId: workspaceGrant, signal: signal }) : "";
    const sentTexts = context.messages.flatMap(message => message.role === "user" ? message.parts.flatMap(part => part.type === "text" ? [part.text] : []) : []);
    const block = buildRequestContext({
      currentTime: formatCurrentTime(),
      workspace,
      // Background commands that ended since the last turn, and those still running.
      backgroundCommands: takeBackgroundCommandContext(conversation.chat.id),
      historyExcerpt: excerpt,
      // Files the user put back with Undo since the last turn, then files changed since the model read them.
      fileChanges: [takeUndoContext(conversation.chat.id), fileChanges].filter(Boolean).join("\n\n"),
      memoryDocument: usesMemory ? memoryForRequest(await readMemoryDocument(), sentTexts) : "",
    });
    // A note from whoever started the turn (a late task run) travels with the rest of the reference data.
    const texts = [block, options.requestNote ?? "", invocation?.directive ?? ""].filter(Boolean);
    await keepRequestContext(conversation.chat.id, latestUserMessage?.id, texts);
    const images = toolsEnabled ? await recentConversationImages(conversation.chat.id, conversation.regenerationSnapshot?.from) : [];
    const mediaContext = images.length ? `Recent picture references in this conversation, newest source first (data, not pixels):\n${JSON.stringify(images)}\nFor visual questions on earlier pictures, read the relevant imageIds with readConversationHistory unless their pixels are already in this request.` : "";
    return { modelMessages: withRequestTexts(modelMessages, [...texts, ...(mediaContext ? [mediaContext] : [])]), partialHistory };
  };

  // A run exists only for a turn that can actually use tools. Creating one
  // for a plain answer would fill the record with empty runs that did nothing.
  const run = toolsEnabled
    ? await startRun({ chatId: conversation.chat.id, goal: latestUserMessage?.text ?? t("chat.run.goalFromConversation") })
    : null;

  return await streamChatResponse({
    input, conversation, systemPrompt, skillsPrompt, toolsEnabled, signal: signal, chosenTool: invocation?.toolId ?? null,
    historyAttachments, approvalMessage,
    ...(awaitsSummary ? {
      settleContext: async () => {
        const attempt = await untilAborted(compactForRequest({ chatId: conversation.chat.id, messages: context.allMessages, keepRecent: context.messages.length, modelRef, allowance: compactionAllowance,
          allowPreviousModel: isChatMode && !input.isApprovalResume && body.trigger !== "regenerate-message" && options.callSource !== "scheduled" }), signal);
        return withEarlierTurns(attempt && "draft" in attempt ? attempt : undefined);
      },
    } : await withEarlierTurns()),
    runId: run?.id ?? null, usesMemory,
    foldHistory: { messages: context.messages, complete: () => historyComplete, revision: input.conversationPolicy?.historyRevision ?? conversation.chat.historyRevision },
    // The prompt has been telling the model which tools this turn could not
    // use. Without this the list never reaches persistence, so the turn's own
    // record could not show it and the "this turn had no web search" badge
    // never rendered — including after a reload, which is the one thing the
    // stored metadata is for.
    unavailableTools,
    compactionAllowance,
    callSource: options.callSource,
  });
}

/** Stops waiting when the request does; the work it was waiting on carries on. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal) {
  return Promise.race([work, new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })]);
}

/**
 * Optional tools this turn cannot use. The list comes from the same source the
 * tool set is built from, so the prompt and the tools can never disagree about
 * what was available.
 */
async function unavailableChatTools(allowedToolIds?: string[], modelSupportsTools = true, modelRef?: ModelRef) {
  // A tool always allowed is never one this turn went without on the template's
  // account, and whether skills are installed says nothing the model has to explain.
  return (await listPublicToolCatalog("chat", modelRef)).filter(tool => tool.surface.template !== "always").flatMap(tool => {
    const reason = allowedToolIds !== undefined && !templateAllowsTool(allowedToolIds, tool.id) ? "templateDisabled"
      : !modelSupportsTools ? "modelUnsupported" : !tool.available ? tool.reason ?? "unavailable" : null;
    return reason ? [{ id: tool.id, reason }] : [];
  });
}
