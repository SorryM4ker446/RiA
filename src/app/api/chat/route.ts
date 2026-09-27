import { protectDataOperation } from "@/lib/server/data-operations";
import { currentWorkspaceId, requireLocalWorkspace } from "@/lib/local/workspace";
import { buildSystemPrompt, formatLongTermContext, prepareModelContext } from "@/lib/chat/model-context";
import { prepareChatPersistence } from "@/lib/chat/persistence";
import { readChatRequest } from "@/lib/chat/request";
import { streamChatResponse } from "@/lib/chat/stream";
import { getRelevantMemories } from "@/lib/memory/store";
import { ApiError, createApiErrorResponse, normalizeApiError } from "@/lib/server/api-error";
import { setupServerProxy } from "@/lib/server/proxy";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { NextRequest } from "next/server";
import { formatDocumentContext, searchDocuments } from "@/lib/documents/retrieval";
import { documentSourceSchema } from "@/lib/documents/types";

async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("chat");
    const input = await readChatRequest(req);
    const { body, modelId, latestUserMessage, isApprovalResume } = input;
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      throw new ApiError({
        code: "CONFIGURATION_ERROR",
        message: "OPENROUTER_API_KEY is not configured. Set it in .env and restart the dev server before chatting.",
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

    const relevantMemories = latestUserMessage?.text
      ? await getRelevantMemories({
        query: latestUserMessage.text,
        limit: 6,
      })
      : [];


    const documentSources = latestUserMessage?.text ? (await searchDocuments(latestUserMessage.text)).map(source => documentSourceSchema.parse(source)) : [];
    const systemPrompt = buildSystemPrompt(context.historyExcerpt || "No earlier messages omitted.", formatLongTermContext(relevantMemories), toolsEnabled) + formatDocumentContext(documentSources);
    return streamChatResponse({ input, conversation, systemPrompt, modelMessages, toolsEnabled, signal: req.signal, documentSources });
  } catch (error) {
    console.error("/api/chat error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to generate chat response");
  }
}

export const POST = protectDataOperation(POSTHandler);
