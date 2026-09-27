import { getApiErrorMessage } from "@/lib/api-error-message";
import { attachmentValidationError } from "@/lib/media/limits";
import { t } from "@/lib/locale";
import type { MediaReference } from "@/lib/media/message-codec";
import { DefaultChatTransport } from "ai";
import type { ChatSummary, MessageStatus, StoredMessage, UploadableFilePart } from "@/features/chat/page-utils";
import type { ChatScopedPreferences, TaskItem, TaskScheduleInput, TaskStatusFilter, ToolCatalogItem } from "@/features/chat/types";

type Data<T> = { data: T };
type Page<T> = Data<T[]> & { pageInfo?: { nextCursor: string | null; hasMore: boolean } };
type GeneratedMedia = { asset: MediaReference; modelId?: string };
type ToolResult = { data: unknown; assistantText?: string };
class ApiClientError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function requestJson<T>(url: string, fallback: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || payload === null) throw new ApiClientError(response.status, getApiErrorMessage(payload, fallback));
  return payload as T;
}

function jsonBody(method: "POST" | "PATCH", body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const conversationPath = (id: string) => `/api/conversations/${encodeURIComponent(id)}`;
const messagePath = (chatId: string, messageId: string) => `${conversationPath(chatId)}/messages/${encodeURIComponent(messageId)}`;
const withCursor = (path: string, cursor?: string) => cursor ? `${path}?${new URLSearchParams({ cursor })}` : path;

export const chatApi = {
  listConversations: (cursor?: string) => requestJson<Page<ChatSummary>>(withCursor("/api/conversations", cursor), t("chatApi.listConversationsFailed")),
  async getConversation(id: string): Promise<Data<ChatSummary | null>> {
    try { return await requestJson<Data<ChatSummary>>(conversationPath(id), t("chatApi.getConversationFailed")); }
    catch (error) {
      if (error instanceof ApiClientError && error.status === 404) return { data: null };
      throw error;
    }
  },
  createConversation: (title: string) => requestJson<Data<ChatSummary>>("/api/conversations", t("chatApi.createConversationFailed"), jsonBody("POST", { title })),
  renameConversation: (id: string, title: string) => requestJson<Data<ChatSummary>>(conversationPath(id), t("chatApi.renameConversationFailed"), jsonBody("PATCH", { title })),
  deleteConversation: (id: string) => requestJson<unknown>(conversationPath(id), t("chatApi.deleteConversationFailed"), { method: "DELETE" }),
  listMessages: (id: string, cursor?: string) => requestJson<Page<StoredMessage>>(withCursor(`${conversationPath(id)}/messages`, cursor), t("chatApi.listMessagesFailed")),
  editMessage: (chatId: string, messageId: string, content: string) => requestJson<unknown>(messagePath(chatId, messageId), t("chatApi.saveEditFailed"), jsonBody("PATCH", { content })),
  deleteMessage: (chatId: string, messageId: string) => requestJson<unknown>(messagePath(chatId, messageId), t("chatApi.deleteMessageFailed"), { method: "DELETE" }),
  listTools: () => requestJson<Data<ToolCatalogItem[]>>("/api/tools?mode=chat", t("chatApi.listToolsFailed")),
  async runTool(tool: string, input: Record<string, unknown>, modelId: string) {
    const failed = `${tool} ${t("chatApi.runToolFailed")}`;
    const payload = await requestJson<ToolResult>("/api/tools/run", failed, jsonBody("POST", { tool, input, modelId, mode: "chat" }));
    if (payload.data === undefined) throw new Error(failed);
    return payload;
  },
  listTasks(status: TaskStatusFilter) {
    const query = new URLSearchParams({ limit: "50" });
    if (status !== "all") query.set("status", status);
    return requestJson<Data<TaskItem[]>>(`/api/tasks?${query}`, t("chatApi.listTasksFailed"));
  },
  updateTask: (id: string, input: Partial<TaskScheduleInput> & { status?: TaskItem["status"] }) => requestJson<Data<TaskItem> & { nextTask?: TaskItem | null }>(`/api/tasks/${encodeURIComponent(id)}`, t("chatApi.updateTaskFailed"), jsonBody("PATCH", input)),
  deleteTask: (id: string) => requestJson<unknown>(`/api/tasks/${encodeURIComponent(id)}`, t("chatApi.deleteTaskFailed"), { method: "DELETE" }),
  async generateMedia(kind: "image" | "video", prompt: string, modelId: string, files: UploadableFilePart[], chatId?: string) {
    const inputs = files.map(({ url, mediaType }) => ({ url, mediaType }));
    const fallback = kind === "image" ? t("chatApi.imageGenerateFailed") : t("chatApi.videoGenerateFailed");
    const payload = await requestJson<GeneratedMedia>(`/api/${kind}`, fallback, jsonBody("POST", {
      prompt, modelId, ...(chatId ? { chatId } : {}), ...(kind === "image" ? { inputImages: inputs } : { inputImage: inputs[0] }),
    }));
    if (!payload.asset) throw new Error(fallback);
    return payload;
  },
  async readImage(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(getApiErrorMessage(await response.json().catch(() => null), t("chatApi.readImageFailed")));
    return response.blob();
  },
};

export async function persistConversationMessage(params: {
  chatId: string;
  role: "user" | "assistant" | "system";
  content: string;
  clientMessageId: string;
  status?: MessageStatus;
}) {
  const { chatId, status = "success", ...message } = params;
  await requestJson<unknown>(`${conversationPath(chatId)}/messages`, t("chatApi.persistMessageFailed"), jsonBody("POST", { ...message, status }));
}

export async function filesToUploadParts(files: File[]): Promise<UploadableFilePart[]> {
  const validation = attachmentValidationError(files);
  if (validation) throw new Error(validation);
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const payload = await requestJson<Data<Array<MediaReference & { filename?: string }>>>("/api/media/upload", t("chatApi.uploadAttachmentFailed"), { method: "POST", body: form });
  if (!payload.data) throw new Error(t("chatApi.uploadAttachmentFailed"));
  return payload.data.map((asset) => ({ type: "file", url: asset.url, mediaType: asset.mediaType, filename: asset.filename }));
}

export function createChatTransport(activeChatId: string | null, preferences: Pick<ChatScopedPreferences, "selectedChatModel" | "manualToolsOnly" | "modelMode">) {
  return new DefaultChatTransport({
    api: "/api/chat",
    body: {
      ...(activeChatId ? { chatId: activeChatId } : {}),
      ...(preferences.selectedChatModel ? { modelId: preferences.selectedChatModel } : {}),
      manualToolsOnly: preferences.modelMode === "chat" ? preferences.manualToolsOnly : true,
      mode: preferences.modelMode,
    },
    prepareSendMessagesRequest: ({ id, messages, trigger, messageId, body }) => ({
      body: { ...body, id, messages: messages.slice(-100), trigger, messageId },
    }),
  });
}
