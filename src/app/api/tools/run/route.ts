import { protectDataOperation } from "@/lib/server/data-operations";
import { enforceRateLimit } from "@/lib/server/rate-limit";
import { readJsonBody } from "@/lib/server/request-body";
import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, normalizeApiError, createApiErrorResponse } from "@/lib/server/api-error";
import { requireLocalWorkspace } from "@/lib/local/workspace";
import { executeRegisteredTool, resolveToolDescriptor } from "@/tools/catalog";
import { templateAllowsTool } from "@/tools/template-access";
import { db } from "@/db";
import { identifierSchema } from "@/lib/server/request-schemas";
import { conversationCollections } from "@/lib/conversations/document-scope";
import { readAssistantSnapshot } from "@/lib/assistants/schema";

const runToolSchema = z.strictObject({
  tool: z.string().trim().min(1).max(100),
  input: z.json(),
  chatId: identifierSchema.optional(),
});

/**
 * Runs a tool the composer can finish without a model, such as converting a
 * document. Everything else goes through the conversation, where the model has
 * the context to fill in the tool's input and to use what it returns.
 */
async function POSTHandler(req: NextRequest) {
  try {
    await requireLocalWorkspace(req);
    enforceRateLimit("tools");
    const parsed = runToolSchema.safeParse(await readJsonBody(req));
    if (!parsed.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid tool request", details: parsed.error.flatten() });
    const toolId = parsed.data.tool;
    const descriptor = await resolveToolDescriptor(toolId);
    if (descriptor?.surface.user?.run !== "direct") throw new ApiError({ code: "VALIDATION_ERROR", message: `Tool ${toolId} cannot run without the conversation` });
    const input = descriptor.inputSchema.safeParse(parsed.data.input);
    if (!input.success) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid tool input", details: input.error.flatten() });
    const conversation = parsed.data.chatId
      ? await db.chat.findUnique({ where: { id: parsed.data.chatId }, select: { topicId: true, documentScope: true, assistantConfig: true } })
      : null;
    if (parsed.data.chatId && !conversation) throw new ApiError({ code: "NOT_FOUND", message: "Conversation was not found" });
    const assistant = readAssistantSnapshot(conversation?.assistantConfig);
    if (assistant && !templateAllowsTool(assistant.tools, toolId)) throw new ApiError({ code: "VALIDATION_ERROR", message: "当前助理模板不允许执行此工具。" });
    const { output } = await executeRegisteredTool(descriptor, input.data, {
      trigger: "manual", signal: req.signal, chatId: parsed.data.chatId,
      documentCollections: conversation ? conversationCollections(conversation) : [],
      documentRetrievalPolicy: assistant?.retrieval,
    });
    return Response.json({ tool: toolId, data: output });
  } catch (error) {
    console.error("/api/tools/run POST error", normalizeApiError(error).code);
    return createApiErrorResponse(error, "Failed to run tool");
  }
}

export const POST = protectDataOperation(POSTHandler);
