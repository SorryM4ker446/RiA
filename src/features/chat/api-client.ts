import { getApiErrorMessage } from "@/lib/api-error-message";
import { attachmentValidationError } from "@/lib/media/limits";
import type { MediaReference } from "@/lib/media/message-codec";
import { DefaultChatTransport } from "ai";
import type { ChatSummary, MessageStatus, StoredMessage, UploadableFilePart } from "@/features/chat/page-utils";
import type { ChatScopedPreferences, TaskItem, TaskStatusFilter, ToolCatalogItem } from "@/features/chat/types";

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
  listConversations: (cursor?: string) => requestJson<Page<ChatSummary>>(withCursor("/api/conversations", cursor), "读取会话列表失败"),
  async getConversation(id: string): Promise<Data<ChatSummary | null>> {
    try { return await requestJson<Data<ChatSummary>>(conversationPath(id), "读取会话失败"); }
    catch (error) {
      if (error instanceof ApiClientError && error.status === 404) return { data: null };
      throw error;
    }
  },
  createConversation: (title: string) => requestJson<Data<ChatSummary>>("/api/conversations", "创建会话失败", jsonBody("POST", { title })),
  renameConversation: (id: string, title: string) => requestJson<Data<ChatSummary>>(conversationPath(id), "重命名会话失败", jsonBody("PATCH", { title })),
  deleteConversation: (id: string) => requestJson<unknown>(conversationPath(id), "删除会话失败", { method: "DELETE" }),
  listMessages: (id: string, cursor?: string) => requestJson<Page<StoredMessage>>(withCursor(`${conversationPath(id)}/messages`, cursor), "读取历史消息失败"),
  editMessage: (chatId: string, messageId: string, content: string) => requestJson<unknown>(messagePath(chatId, messageId), "保存修改失败", jsonBody("PATCH", { content })),
  deleteMessage: (chatId: string, messageId: string) => requestJson<unknown>(messagePath(chatId, messageId), "删除消息失败", { method: "DELETE" }),
  listTools: () => requestJson<Data<ToolCatalogItem[]>>("/api/tools?mode=chat", "读取工具目录失败"),
  async runTool(tool: string, input: Record<string, unknown>, modelId: string) {
    const payload = await requestJson<ToolResult>("/api/tools/run", `${tool} 执行失败`, jsonBody("POST", { tool, input, modelId, mode: "chat" }));
    if (payload.data === undefined) throw new Error(`${tool} 执行失败`);
    return payload;
  },
  listTasks(status: TaskStatusFilter) {
    const query = new URLSearchParams({ limit: "50" });
    if (status !== "all") query.set("status", status);
    return requestJson<Data<TaskItem[]>>(`/api/tasks?${query}`, "读取任务失败");
  },
  updateTask: (id: string, status: TaskItem["status"]) => requestJson<Data<TaskItem>>(`/api/tasks/${encodeURIComponent(id)}`, "更新任务失败", jsonBody("PATCH", { status })),
  deleteTask: (id: string) => requestJson<unknown>(`/api/tasks/${encodeURIComponent(id)}`, "删除任务失败", { method: "DELETE" }),
  async generateMedia(kind: "image" | "video", prompt: string, modelId: string, files: UploadableFilePart[]) {
    const inputs = files.map(({ url, mediaType }) => ({ url, mediaType }));
    const fallback = kind === "image" ? "图片生成失败" : "视频生成失败";
    const payload = await requestJson<GeneratedMedia>(`/api/${kind}`, fallback, jsonBody("POST", {
      prompt, modelId, ...(kind === "image" ? { inputImages: inputs } : { inputImage: inputs[0] }),
    }));
    if (!payload.asset) throw new Error(fallback);
    return payload;
  },
  async readImage(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(getApiErrorMessage(await response.json().catch(() => null), "读取图片失败，无法加入图片附件。"));
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
  await requestJson<unknown>(`${conversationPath(chatId)}/messages`, "保存消息失败", jsonBody("POST", { ...message, status }));
}

export async function filesToUploadParts(files: File[]): Promise<UploadableFilePart[]> {
  const validation = attachmentValidationError(files);
  if (validation) throw new Error(validation);
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const payload = await requestJson<Data<Array<MediaReference & { filename?: string }>>>("/api/media/upload", "附件上传失败", { method: "POST", body: form });
  if (!payload.data) throw new Error("附件上传失败");
  return payload.data.map((asset) => ({ type: "file", url: asset.url, mediaType: asset.mediaType, filename: asset.filename }));
}

export function createChatTransport(activeChatId: string | null, preferences: Pick<ChatScopedPreferences, "selectedChatModel" | "manualToolsOnly" | "modelMode">) {
  return new DefaultChatTransport({
    api: "/api/chat",
    body: {
      ...(activeChatId ? { chatId: activeChatId } : {}),
      modelId: preferences.selectedChatModel,
      manualToolsOnly: preferences.modelMode === "chat" ? preferences.manualToolsOnly : true,
      mode: preferences.modelMode,
    },
    prepareSendMessagesRequest: ({ id, messages, trigger, messageId, body }) => ({
      body: { ...body, id, messages: messages.slice(-100), trigger, messageId },
    }),
  });
}
