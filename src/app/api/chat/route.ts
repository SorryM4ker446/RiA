import { protectDataOperation } from "@/lib/server/data-operations";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { buildRequestContext, buildSystemPrompt, filesSeen, formatCurrentTime, formatKnowledgeScope, keepRequestContext, prepareModelContext, storedSummary, withRequestTexts } from "@/lib/chat/model-context";
import { changedFiles } from "@/lib/chat/compaction-restore";
import { memoryForRequest, readMemoryDocument } from "@/lib/memory/document";
import { prepareChatPersistence } from "@/lib/chat/persistence";
import { readChatRequest } from "@/lib/chat/request";
import { streamChatResponse } from "@/lib/chat/stream";
import { startRun } from "@/lib/agent/runs";
import { modelRefKey, type ModelRef } from "@/lib/models/preferences-schema";
import { contextBudget } from "@/lib/models/context-budget";
import { getModelPreferences } from "@/lib/models/preferences";
import { getModelProvider } from "@/lib/models/providers";
import { compactForRequest } from "@/lib/chat/compaction";
import { createCompactionAllowance } from "@/lib/chat/task-summary";
import { getTextFromUIMessage as readText } from "@/lib/ai/ui-message";
import type { UIMessage } from "ai";
import { t } from "@/lib/locale";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { setupServerProxy } from "@/lib/server/proxy";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { NextRequest } from "next/server";
import { listPublicToolCatalog } from "@/tools/catalog";
import { templateAllowsTool } from "@/tools/template-access";
import { formatAssistantInstructions } from "@/lib/assistants/schema";
import { formatPluginSkills } from "@/lib/plugins/store";
import { conversationCollections } from "@/lib/conversations/document-scope";
import { conversationWorkspace, formatWorkspaceContext } from "@/lib/local-files/workspace";
import { resolveInvocation } from "@/lib/chat/invocation";
import { db } from "@/db";

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("chat");
    const input = await readChatRequest(req);
    const { body, modelRef, latestUserMessage } = input;
    // Checked against the provider the chosen model actually belongs to. Naming
    // OpenRouter here refused every DeepSeek-only install before it could say so,
    // which is the one thing a user who only ever added a DeepSeek model needs
    // to be able to run.
    if (!getModelProvider(modelRef.providerId).isConfigured()) {
      throw new ApiError({
        code: "CONFIGURATION_ERROR",
        message: `${modelRef.providerId.toUpperCase()}_API_KEY is not configured. Set it in .env and restart the dev server before chatting.`,
      });
    }
    setupServerProxy();


    const { context, modelMessages } = await prepareModelContext(input, req.signal);
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
    const conversation = await prepareChatPersistence(input, { deferApproval: true });
    const unavailableStatuses = await unavailableChatTools(input.assistant?.tools, canUseTools, modelRef);
    const unavailableTools = unavailableStatuses.map(tool => tool.id);

    // The switch is about long-term memory: MEMORY.md and the tool that writes it. It is
    // not a promise that nothing is kept: the messages, uploads and usage stay as they
    // otherwise would, and the knowledge base is still there to draw on.
    const usesMemory = !(input.conversationPolicy?.ephemeral ?? conversation.chat.ephemeral);
    // One allowance per request covers older-turn summaries and in-stream compaction.
    const compactionAllowance = createCompactionAllowance((await getModelPreferences()).callLimits.compactionCallsPerTurn);
    // Long conversations are compressed by a model-written summary that covers the
    // older turns and names the last message it includes; it never replaces the
    // stored messages. A finished turn nearing the limit keeps it up to date in the
    // background, so a request reads what is there and excerpts fill any gap behind
    // it. Only a conversation with no summary yet waits for one, and says so.
    const olderTurns = latestUserMessage?.text ? context.allMessages.slice(0, context.omittedMessages) : [];
    const awaitsSummary = olderTurns.length > 0 && !input.isApprovalResume && !await storedSummary(conversation.chat.id);

    // The system prompt carries only rules that stay the same across turns. The
    // optional tools configured away this turn are named there, so the model
    // can answer honestly about what it could not check.
    const skillsPrompt = await formatPluginSkills({ onDemand: toolsEnabled });
    const systemPrompt = buildSystemPrompt(toolsEnabled, unavailableStatuses, (await getModelPreferences()).persona)
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
    let historyComplete = olderTurns.length === 0;
    // This turn's reference data travels with the user's message.
    const withEarlierTurns = async () => {
      const stored = await storedSummary(conversation.chat.id);
      historyComplete ||= Boolean(stored?.coveredIds.includes(olderTurns.at(-1)!.id));
      // An approval resuming continues the same request, which already holds its context.
      if (input.isApprovalResume) return modelMessages;
      const workspaceGrant = toolsEnabled && (!input.assistant || templateAllowsTool(input.assistant.tools, "readProjectFile")) ? (await conversationWorkspace(conversation.chat.id))?.id : null;
      const fileChanges = workspaceGrant ? await changedFiles({ seen: filesSeen(stored?.state, context.messages, workspaceGrant), grantId: workspaceGrant, signal: req.signal }) : "";
      const sentTexts = context.messages.flatMap(message => message.role === "user" ? message.parts.flatMap(part => part.type === "text" ? [part.text] : []) : []);
      const block = buildRequestContext({
        currentTime: formatCurrentTime(),
        workspace,
        historyExcerpt: historyComplete ? "" : context.historyExcerpt,
        fileChanges,
        memoryDocument: usesMemory ? memoryForRequest(await readMemoryDocument(), sentTexts) : "",
      });
      const texts = [block, invocation?.directive ?? ""].filter(Boolean);
      await keepRequestContext(conversation.chat.id, latestUserMessage?.id, texts);
      return withRequestTexts(modelMessages, texts);
    };

    // A run exists only for a turn that can actually use tools. Creating one
    // for a plain answer would fill the record with empty runs that did nothing.
    const run = toolsEnabled
      ? await startRun({ chatId: conversation.chat.id, goal: latestUserMessage?.text ?? t("chat.run.goalFromConversation") })
      : null;

    return await streamChatResponse({
      input, conversation, systemPrompt, skillsPrompt, toolsEnabled, signal: req.signal, chosenTool: invocation?.toolId ?? null,
      ...(awaitsSummary ? {
        settleContext: async () => {
          await untilAborted(compactForRequest({ chatId: conversation.chat.id, messages: context.allMessages, keepRecent: context.messages.length, modelRef, allowance: compactionAllowance }), req.signal);
          return withEarlierTurns();
        },
      } : { modelMessages: await withEarlierTurns() }),
      runId: run?.id ?? null, usesMemory,
      foldHistory: { messages: context.messages, complete: () => historyComplete },
      // The prompt has been telling the model which tools this turn could not
      // use. Without this the list never reaches persistence, so the turn's own
      // record could not show it and the "this turn had no web search" badge
      // never rendered — including after a reload, which is the one thing the
      // stored metadata is for.
      unavailableTools,
      compactionAllowance,
    });
  } catch (error) {
    console.error("/api/chat error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to generate chat response");
  }
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

export const POST = protectDataOperation(POSTHandler);
