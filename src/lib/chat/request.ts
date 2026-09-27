import { db } from "@/db";
import { t } from "@/lib/locale";
import { getLatestUserMessage } from "@/lib/ai/ui-message";
import { isToolApprovalContinuation } from "@/lib/chat/context";
import { resolveImageInputs } from "@/lib/media/messages";
import { ApiError } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { chatRequestSchema } from "@/lib/server/request-schemas";
import { preferredModel, modelInLibrary } from "@/lib/models/preferences";
import { validateUIMessages, type UIMessage } from "ai";

export async function readChatRequest(req: Request) {
  const body = chatRequestSchema.parse(await readJsonBody(req));
  const messages = await validateUIMessages<UIMessage>({ messages: body.messages }).catch(() => {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid message parts or tool state" });
  });
  const modelId = await preferredModel("chat", body.modelId);
  const model = await modelInLibrary("chat", modelId);
  const latestUserMessage = getLatestUserMessage(messages);
  const isApprovalResume = isToolApprovalContinuation(messages);
  const requestedChatId = body.chatId ?? body.conversationId ?? body.id;
  if (requestedChatId) {
    const existing = await db.chat.findUnique({ where: { id: requestedChatId }, select: { id: true } });
    // Resuming an approval requires the conversation that holds the pending request.
    if (!existing && isApprovalResume) {
      throw new ApiError({ code: "NOT_FOUND", message: "Conversation was not found" });
    }
  }
  for (const message of messages) {
    const files = message.parts.filter((part) => part.type === "file");
    if (files.length) await resolveImageInputs(files);
  }

  if (latestUserMessage?.files.length && !model?.supportsImageInput) {
    throw new ApiError({
      code: "VALIDATION_ERROR",
      message: `${t("lib.models.chatPrefix")} ${modelId} ${t("lib.models.chatNoImageSwitch")}`,
    });
  }
  if (isApprovalResume && !model?.supportsTools) {
    throw new ApiError({
      code: "VALIDATION_ERROR",
      message: `${t("lib.models.chatPrefix")} ${modelId} ${t("lib.models.chatNoToolsApproval")}`,
    });
  }

  return { body, messages, modelId, model, latestUserMessage, isApprovalResume, requestedChatId };
}
export type ChatRequest = Awaited<ReturnType<typeof readChatRequest>>;
