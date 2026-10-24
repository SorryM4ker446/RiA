import { protectDataOperation } from "@/lib/server/data-operations";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { buildRequestContext, buildSystemPrompt, formatLongTermContext, prepareModelContext, withRequestContext } from "@/lib/chat/model-context";
import { prepareChatPersistence } from "@/lib/chat/persistence";
import { readChatRequest } from "@/lib/chat/request";
import { streamChatResponse } from "@/lib/chat/stream";
import { getRelevantMemories } from "@/lib/memory/store";
import { startRun } from "@/lib/agent/runs";
import type { ModelRef } from "@/lib/models/preferences-schema";
import { getModelPreferences } from "@/lib/models/preferences";
import { getModelProvider } from "@/lib/models/providers";
import { summarizeOlderTurns } from "@/lib/chat/summary";
import { createCompactionAllowance } from "@/lib/chat/task-summary";
import { getTextFromUIMessage as readText } from "@/lib/ai/ui-message";
import type { UIMessage } from "ai";
import { t } from "@/lib/locale";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { setupServerProxy } from "@/lib/server/proxy";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { NextRequest } from "next/server";
import { documentRetrievalQuery, formatDocumentContext, retrieveDocuments } from "@/lib/documents/retrieval";
import { listPublicToolCatalog } from "@/tools/catalog";
import { documentSourceSchema } from "@/lib/documents/types";
import { decodeDocumentScope } from "@/lib/documents/scope";
import { formatAssistantInstructions } from "@/lib/assistants/schema";
import { formatPluginSkills } from "@/lib/plugins/store";
import { selectAutomaticEvidence } from "@/lib/documents/auto-context";
import { CONTEXT_MEMORY_MIN_MATCH } from "@/lib/memory/retrieval";
import { conversationWorkspace, formatWorkspaceContext } from "@/lib/local-files/workspace";
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
    const conversation = await prepareChatPersistence(input, { deferApproval: true });
    const mode = body.mode ?? "chat";
    const isChatMode = mode === "chat";
    const canUseTools = isChatMode && input.model?.supportsTools === true;
    // The chat model decides for itself whether a tool helps, so tools stay
    // attached for the whole turn. Selection follows the task instructions
    // and each tool's modelDescription, not from a second LLM call that would
    // have to guess from the latest message alone.
    const toolsEnabled = canUseTools && (!input.assistant || input.assistant.tools.length > 0);
    const unavailableStatuses = await unavailableChatTools(input.assistant?.tools, canUseTools, modelRef);
    const unavailableTools = unavailableStatuses.map(tool => tool.id);

    // An ephemeral conversation neither reads long-term memory nor writes any.
    // It is a memory switch, not a promise that nothing is kept: the messages,
    // uploads and usage stay exactly as they otherwise would.
    const usesMemory = !(input.conversationPolicy?.ephemeral ?? conversation.chat.ephemeral);
    // A shared keyword alone does not make a memory part of every request.
    const relevantMemories = usesMemory && latestUserMessage?.text
      ? await getRelevantMemories({
        query: latestUserMessage.text,
        followUp: previousUserText(input.messages),
        limit: 6,
        minMatch: CONTEXT_MEMORY_MIN_MATCH,
        signal: req.signal,
      })
      : [];


    // A conversation that named its document topics only draws on those; an
    // empty scope means every topic, as before.
    const scope = decodeDocumentScope(input.conversationPolicy?.documentScope ?? conversation.chat.documentScope);
    // Long conversations are compressed by a model-written summary that covers
    // the older turns and names the last message it includes. A summary never
    // replaces the stored messages themselves.
    // One allowance per request covers older-turn summaries and in-stream compaction.
    const compactionAllowance = createCompactionAllowance((await getModelPreferences()).callLimits.compactionCallsPerTurn);
    const summary = latestUserMessage?.text
      ? await summarizeOlderTurns({
        chatId: conversation.chat.id,
        messages: context.allMessages.map((message) => ({ id: message.id ?? "", role: message.role, text: readText(message) })),
        keepRecent: context.messages.length,
        force: context.omittedMessages > 0,
        modelRef,
        signal: req.signal,
        allowance: compactionAllowance,
      }).catch(() => null)
      : null;

    const knowledgeQuery = documentRetrievalQuery(context.allMessages.map(message => ({ role: message.role, text: readText(message) })));
    const retrievalQuery = knowledgeQuery || latestUserMessage?.text || "";
    const searchable = toolsEnabled && !unavailableTools.includes("searchKnowledge") && (!input.assistant || input.assistant.tools.includes("searchKnowledge"));
    const retrieved = latestUserMessage?.text
      ? selectAutomaticEvidence(await retrieveDocuments(retrievalQuery, 8, scope, req.signal, input.assistant?.retrieval), retrievalQuery,
        { userScoped: scope.length > 0 || (input.assistant?.collections.length ?? 0) > 0, canSearch: searchable })
      : null;
    const documentSources = retrieved?.sources.map(source => documentSourceSchema.parse(source)) ?? [];
    // The system prompt carries only rules that stay the same across turns. The
    // optional tools configured away this turn are named there, so the model
    // can answer honestly about what it could not check.
    const systemPrompt = buildSystemPrompt(toolsEnabled, unavailableStatuses, (await getModelPreferences()).persona)
      + formatAssistantInstructions(input.assistant) + await formatPluginSkills({ onDemand: toolsEnabled });
    // This turn's reference data travels with the user's message. Excerpts of
    // older turns are a fallback for when no summary covers them.
    // Which folder this conversation works in is restated on every request, so
    // a switch made between turns is what the model acts on next.
    const workspace = toolsEnabled && (!input.assistant || input.assistant.tools.includes("runTerminalCommand"))
      ? formatWorkspaceContext(await conversationWorkspace(conversation.chat.id), await db.directoryGrant.count({ where: { revokedAt: null } }) > 0)
      : "";
    const requestContext = buildRequestContext({
      workspace,
      summary: summary?.summary,
      historyExcerpt: summary ? "" : context.historyExcerpt,
      memories: formatLongTermContext(relevantMemories),
      evidence: formatDocumentContext(documentSources),
    });

    // A run exists only for a turn that can actually use tools. Creating one
    // for a plain answer would fill the record with empty runs that did nothing.
    const run = toolsEnabled
      ? await startRun({ chatId: conversation.chat.id, goal: latestUserMessage?.text ?? t("chat.run.goalFromConversation") })
      : null;

    return await streamChatResponse({
      input, conversation, systemPrompt, modelMessages: withRequestContext(modelMessages, requestContext), toolsEnabled, signal: req.signal,
      documentSources, documentDiagnostics: retrieved?.diagnostics, runId: run?.id ?? null, usesMemory,
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

/** The user message before the latest one, as plain text. */
function previousUserText(messages: UIMessage[]): string | undefined {
  const users = messages.filter(message => message.role === "user");
  const previous = users.at(-2);
  return previous ? readText(previous) || undefined : undefined;
}

/**
 * Optional tools this turn cannot use. The list comes from the same source the
 * tool set is built from, so the prompt and the tools can never disagree about
 * what was available.
 */
async function unavailableChatTools(allowedToolIds?: string[], modelSupportsTools = true, modelRef?: ModelRef) {
  return (await listPublicToolCatalog("chat", modelRef)).flatMap(tool => {
    const reason = allowedToolIds !== undefined && !allowedToolIds.includes(tool.id) ? "templateDisabled"
      : !modelSupportsTools ? "modelUnsupported" : !tool.available ? tool.reason ?? "unavailable" : null;
    return reason ? [{ id: tool.id, reason }] : [];
  });
}

export const POST = protectDataOperation(POSTHandler);
