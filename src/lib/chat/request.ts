import { chatModelSupportsImageInput, resolveModelId } from "@/config/model";
import { db } from "@/db";
import { getLatestUserMessage } from "@/lib/ai/ui-message";
import { isToolApprovalContinuation } from "@/lib/chat/context";
import { resolveImageInputs } from "@/lib/media/messages";
import { ApiError } from "@/lib/server/api-error";
import { readJsonBody } from "@/lib/server/request-body";
import { chatRequestSchema } from "@/lib/server/request-schemas";
import { preferredModel } from "@/lib/models/preferences";
import { validateUIMessages, type UIMessage } from "ai";

export async function readChatRequest(req: Request, userId: string) {
  const body = chatRequestSchema.parse(await readJsonBody(req));
  const messages = await validateUIMessages<UIMessage>({ messages: body.messages }).catch(() => {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid message parts or tool state" });
  });
  const modelId = resolveModelId(await preferredModel(userId, "chat", body.modelId));
  const latestUserMessage = getLatestUserMessage(messages);
  const isApprovalResume = isToolApprovalContinuation(messages);
  const requestedChatId = body.chatId ?? body.conversationId ?? body.id;
  if (requestedChatId) {
    const existing = await db.chat.findUnique({ where: { id: requestedChatId }, select: { userId: true } });
    if ((existing && existing.userId !== userId) || (!existing && isApprovalResume)) {
      throw new ApiError({ code: "NOT_FOUND", message: "Conversation was not found" });
    }
  }
  for (const message of messages) {
    const files = message.parts.filter((part) => part.type === "file");
    if (files.length) await resolveImageInputs(userId, files);
  }

  if (latestUserMessage?.files.length && !chatModelSupportsImageInput(modelId)) {
    throw new ApiError({
      code: "VALIDATION_ERROR",
      message: `当前聊天模型 ${modelId} 不支持图片输入，请切换到支持视觉的模型。`,
    });
  }

  return { body, messages, modelId, latestUserMessage, isApprovalResume, requestedChatId };
}
export type ChatRequest = Awaited<ReturnType<typeof readChatRequest>>;
