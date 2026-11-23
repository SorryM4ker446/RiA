import { db } from "@/db";
import { t } from "@/lib/locale";
import { getLatestUserMessage } from "@/lib/ai/ui-message";
import { isToolApprovalContinuation } from "@/lib/chat/context";
import { resolveChatAttachments } from "@/lib/media/messages";
import { ApiError } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { chatRequestSchema } from "@/lib/server/request-schemas";
import { preferredModel, modelInLibrary, getModelPreferences } from "@/lib/models/preferences";
import { validateUIMessages, type UIMessage } from "ai";
import { externalInputSchema, externalToolIdPattern } from "@/lib/extensions/schema";
import { resolveToolDescriptor, toolAvailability } from "@/tools/registry";
import { templateAllowsTool } from "@/tools/template-access";
import { conversationModel, conversationModelSelect } from "@/lib/chat/conversation-model";

export async function readChatRequest(req: Request) {
  // Terminal scripts are echoed in approvals and later history. Read them in
  // full rather than imposing a per-request limit on their input length.
  return parseChatRequest(await readJsonBody(req, null));
}

/** A chat request from its body, wherever that came from: the page, or a task running on its own. */
export async function parseChatRequest(raw: unknown) {
  const body = chatRequestSchema.parse(raw);
  const messages = await validateUIMessages<UIMessage>({ messages: body.messages }).catch(() => {
    throw new ApiError({ code: "VALIDATION_ERROR", message: t("server.chat.invalidParts") });
  });
  const requestedChatId = body.chatId ?? body.conversationId ?? body.id;
  const existing = requestedChatId ? await db.chat.findUnique({ where: { id: requestedChatId }, select: {
    id: true, historyRevision: true, ...conversationModelSelect,
  } }) : null;
  // Read once here so the chat call and every auxiliary call in the same turn
  // reason the same way, instead of each reading it at a different moment.
  const settings = await getModelPreferences();
  // A task's conversation takes its model, memory switch and reasoning from the
  // task; another, its model from a template that names one.
  const { task, assistant, bound, memoryOff, thinking } = await conversationModel(existing, settings.thinking);
  if (bound && body.model && (body.model.providerId !== bound.providerId || body.model.modelId !== bound.modelId)) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: task ? "This conversation belongs to a task and uses the task's model; change the model on the task." : t("errors.thisConversationUsesATemplateAssignedModelRemove") });
  }
  const modelRef = await preferredModel("chat", bound ?? body.model);
  const model = await modelInLibrary("chat", modelRef);
  const reasoning = thinking ?? settings.thinking;
  const latestUserMessage = getLatestUserMessage(messages);
  const isApprovalResume = isToolApprovalContinuation(messages);
  if (isApprovalResume) {
    for (const part of messages.at(-1)!.parts) {
      if (!part.type.startsWith("tool-") || !("state" in part) || part.state !== "approval-responded" || !("approval" in part) || !part.approval?.approved) continue;
      const id = part.type.slice(5);
      if (!externalToolIdPattern.test(id)) continue;
      const tool = await resolveToolDescriptor(id);
      const parsed = "input" in part ? externalInputSchema.safeParse(part.input) : null;
      if (!tool || !(await toolAvailability(id)).available || !parsed?.success || parsed.data.binding?.revision !== tool.extensionRevision || parsed.data.binding?.extensionId !== tool.extensionId || !tool.inputSchema.safeParse(parsed.data).success) {
        throw new ApiError({ code: "CONFLICT", message: t("errors.extensionDisabledDeletedOrReconfiguredStartAndConfirm") });
      }
    }
  }
  if (requestedChatId) {
    // Resuming an approval requires the conversation that holds the pending request.
    if (!existing && isApprovalResume) {
      throw new ApiError({ code: "NOT_FOUND", message: t("server.conversation.notFound") });
    }
  }
  if (isApprovalResume && assistant && messages.some(message => message.parts.some(part => part.type.startsWith("tool-") && "state" in part && part.state === "approval-responded" && !templateAllowsTool(assistant.tools, part.type.slice(5))))) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: t("errors.theCurrentAssistantTemplateDoesNotAllowThis") });
  }
  if (!isApprovalResume && latestUserMessage?.files.length) await resolveChatAttachments(latestUserMessage.files);

  if (!isApprovalResume && latestUserMessage?.files.some(file => file.mediaType.startsWith("image/")) && !model?.supportsImageInput) {
    throw new ApiError({
      code: "VALIDATION_ERROR",
      message: `${t("lib.models.chatPrefix")} ${modelRef.modelId} ${t("lib.models.chatNoImageSwitch")}`,
    });
  }
  if (isApprovalResume && !model?.supportsTools) {
    throw new ApiError({
      code: "VALIDATION_ERROR",
      message: `${t("lib.models.chatPrefix")} ${modelRef.modelId} ${t("lib.models.chatNoToolsApproval")}`,
    });
  }

  // The memory switch the turn honours is the task's for a task's conversation.
  const conversationPolicy = existing ? { ...existing, ephemeral: memoryOff ?? existing.ephemeral } : null;
  return { body, messages, modelRef, model, reasoning, latestUserMessage, isApprovalResume, requestedChatId, assistant, conversationPolicy };
}
export type ChatRequest = Awaited<ReturnType<typeof parseChatRequest>>;
