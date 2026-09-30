import { protectDataOperation } from "@/lib/server/data-operations";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { buildSystemPrompt, formatLongTermContext, prepareModelContext } from "@/lib/chat/model-context";
import { prepareChatPersistence } from "@/lib/chat/persistence";
import { readChatRequest } from "@/lib/chat/request";
import { streamChatResponse } from "@/lib/chat/stream";
import { getRelevantMemories } from "@/lib/memory/store";
import { startRun } from "@/lib/agent/runs";
import { getModelPreferences } from "@/lib/models/preferences";
import { getModelProvider } from "@/lib/models/providers";
import { summarizeOlderTurns } from "@/lib/chat/summary";
import { getTextFromUIMessage as readText } from "@/lib/ai/ui-message";
import { t } from "@/lib/locale";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { setupServerProxy } from "@/lib/server/proxy";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { NextRequest } from "next/server";
import { formatDocumentContext, searchDocuments } from "@/lib/documents/retrieval";
import { listPublicToolCatalog } from "@/tools/catalog";
import { documentSourceSchema } from "@/lib/documents/types";

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("chat");
    const input = await readChatRequest(req);
    const { body, modelRef, latestUserMessage, isApprovalResume } = input;
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


    const { context, modelMessages } = await prepareModelContext(input);
    const conversation = await prepareChatPersistence(input);
    const mode = body.mode ?? "chat";
    const isChatMode = mode === "chat";
    const canUseTools = isChatMode && input.model?.supportsTools === true;
    // The chat model decides for itself whether a tool helps, so tools stay
    // attached for the whole turn. Restraint comes from TOOL_ENABLED_INSTRUCTIONS
    // and each tool's modelDescription, not from a second LLM call that would
    // have to guess from the latest message alone.
    const toolsEnabled = canUseTools && (isApprovalResume || !body.manualToolsOnly);
  const unavailableTools = toolsEnabled ? await unavailableChatTools() : [];

    // An ephemeral conversation neither reads long-term memory nor writes any.
    // It is a memory switch, not a promise that nothing is kept: the messages,
    // uploads and usage stay exactly as they otherwise would.
    const usesMemory = !conversation.chat.ephemeral;
    const relevantMemories = usesMemory && latestUserMessage?.text
      ? await getRelevantMemories({
        query: latestUserMessage.text,
        limit: 6,
      })
      : [];


    // A conversation that named its document topics only draws on those; an
    // empty scope means every topic, as before.
    const scope = (conversation.chat.documentScope ?? "").split("|").filter(Boolean);
    // Long conversations are compressed by a model-written summary that covers
    // the older turns and names the last message it includes. The bounded
    // excerpts stay in the prompt either way, and a summary never replaces the
    // messages themselves.
    const summary = latestUserMessage?.text
      ? await summarizeOlderTurns({
        chatId: conversation.chat.id,
        messages: context.allMessages.map((message) => ({ id: message.id ?? "", role: message.role, text: readText(message) })),
        keepRecent: 24,
      }).catch(() => null)
      : null;

    const documentSources = latestUserMessage?.text ? (await searchDocuments(latestUserMessage.text, 4, scope)).map(source => documentSourceSchema.parse(source)) : [];
    // The optional tools that are configured away this turn are named in the
    // prompt, so the model can answer honestly about what it could not check.
    const systemPrompt = buildSystemPrompt(
      [
        summary ? `[Summary of earlier turns - a model-written condensation, not the original text: ${summary.summary}]` : "",
        context.historyExcerpt || "No earlier messages omitted.",
      ].filter(Boolean).join(String.fromCharCode(10, 10)),
      formatLongTermContext(relevantMemories),
      toolsEnabled,
      unavailableTools,
      (await getModelPreferences()).persona,
    ) + formatDocumentContext(documentSources);

    // A run exists only for a turn that can actually use tools. Creating one
    // for a plain answer would fill the record with empty runs that did nothing.
    const run = toolsEnabled
      ? await startRun({ chatId: conversation.chat.id, goal: latestUserMessage?.text ?? t("chat.run.goalFromConversation") }).catch(() => null)
      : null;

    return await streamChatResponse({
      input, conversation, systemPrompt, modelMessages, toolsEnabled, signal: req.signal,
      documentSources, runId: run?.id ?? null, usesMemory,
      // The prompt has been telling the model which tools this turn could not
      // use. Without this the list never reaches persistence, so the turn's own
      // record could not show it and the "this turn had no web search" badge
      // never rendered — including after a reload, which is the one thing the
      // stored metadata is for.
      unavailableTools,
    });
  } catch (error) {
    console.error("/api/chat error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to generate chat response");
  }
}

/**
 * Optional tools this turn cannot use. The list comes from the same source the
 * tool set is built from, so the prompt and the tools can never disagree about
 * what was available.
 */
async function unavailableChatTools() {
  return (await listPublicToolCatalog("chat")).filter(tool => !tool.available).map(tool => tool.id);
}

export const POST = protectDataOperation(POSTHandler);
