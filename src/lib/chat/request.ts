import { db } from "@/db";
import { t } from "@/lib/locale";
import { getLatestUserMessage } from "@/lib/ai/ui-message";
import { isToolApprovalContinuation } from "@/lib/chat/context";
import { resolveImageInputs } from "@/lib/media/messages";
import { ApiError } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { chatRequestSchema } from "@/lib/server/request-schemas";
import { preferredModel, modelInLibrary, getModelPreferences } from "@/lib/models/preferences";
import { validateUIMessages, type UIMessage } from "ai";
import { readAssistantSnapshot } from "@/lib/assistants/schema";
import { externalInputSchema, externalToolIdPattern } from "@/lib/extensions/schema";
import { resolveToolDescriptor, toolAvailability } from "@/tools/registry";

export async function readChatRequest(req: Request) {
  const body = chatRequestSchema.parse(await readJsonBody(req));
  const messages = await validateUIMessages<UIMessage>({ messages: body.messages }).catch(() => {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid message parts or tool state" });
  });
  const requestedChatId = body.chatId ?? body.conversationId ?? body.id;
  const existing = requestedChatId ? await db.chat.findUnique({ where: { id: requestedChatId }, select: { id: true, assistantConfig: true, documentScope: true, ephemeral: true } }) : null;
  const assistant = readAssistantSnapshot(existing?.assistantConfig);
  if (assistant?.model && body.model && (body.model.providerId !== assistant.model.providerId || body.model.modelId !== assistant.model.modelId)) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "会话使用模板绑定的模型，请移除模板后切换模型。" });
  }
  const modelRef = await preferredModel("chat", assistant?.model ?? body.model);
  const model = await modelInLibrary("chat", modelRef);
  // Read once here so the chat call and every auxiliary call in the same turn
  // reason the same way, instead of each reading it at a different moment.
  const settings = await getModelPreferences();
  const reasoning = settings.thinking;
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
        throw new ApiError({ code: "CONFLICT", message: "扩展已停用、删除或配置已变化。请重新发起操作并确认。" });
      }
    }
  }
  if (requestedChatId) {
    // Resuming an approval requires the conversation that holds the pending request.
    if (!existing && isApprovalResume) {
      throw new ApiError({ code: "NOT_FOUND", message: "Conversation was not found" });
    }
  }
  if (isApprovalResume && assistant && messages.some(message => message.parts.some(part => part.type.startsWith("tool-") && "state" in part && part.state === "approval-responded" && !assistant.tools.includes(part.type.slice(5))))) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "当前助理模板不允许执行此工具。" });
  }
  for (const message of messages) {
    const files = message.parts.filter((part) => part.type === "file");
    if (files.length) await resolveImageInputs(files);
  }

  if (latestUserMessage?.files.length && !model?.supportsImageInput) {
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

  return { body, messages, modelRef, model, reasoning, latestUserMessage, isApprovalResume, requestedChatId, assistant, conversationPolicy: existing };
}
export type ChatRequest = Awaited<ReturnType<typeof readChatRequest>>;
