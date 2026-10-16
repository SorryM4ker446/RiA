import type { AssistantSnapshot } from "@/lib/assistants/schema";
import {
  decodePersistedAssistantToolMessage,
  decodePersistedUserMessage,
} from "@/lib/ai/ui-message";
import { decodeMediaMessage, encodeMediaMessage, mediaUrl, type StoredMediaMessage } from "@/lib/media/message-codec";
import { formatDateTime } from "@/lib/locale";
import { t } from "@/lib/locale";
import { UIMessage } from "ai";

export type ChatSummary = {
  id: string;
  title: string;
  lastMessageAt: string;
  messageCount: number;
  pinned?: boolean;
  archived?: boolean;
  ephemeral?: boolean;
  documentScope?: string;
  assistantConfig?: AssistantSnapshot | null;
  tags?: string[];
};

/**
 * A message as the browser receives it, so the fields are the serialised ones.
 *
 * `createdAt` is deliberately absent: the API sends it, but nothing in the
 * client reads it, and declaring it here only invited callers to hand over a
 * database row — where it is a `Date` — as if it were already on the wire.
 * `status` is here because the API does send it and a message can be stored as
 * pending, successful or failed.
 */
export type StoredMessage = {
  id: string;
  clientMessageId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  status?: "pending" | "success" | "error";
};

export type ToolPart = Extract<UIMessage["parts"][number], { type: `tool-${string}` }>;
export type FilePart = Extract<UIMessage["parts"][number], { type: "file" }>;
export type ModelMode = "chat" | "image" | "video";
export type MessageStatus = "pending" | "success" | "error";

export type StoredImageMessagePayload = StoredMediaMessage & { type: "image-result" };

export type StoredVideoMessagePayload = StoredMediaMessage & { type: "video-result" };

export type UploadableFilePart = {
  type: "file";
  url: string;
  mediaType: string;
  filename?: string;
};

export const quickPrompts = [
  t("chat.prompts.quickSummarize"),
  t("chat.prompts.quickRewrite"),
  t("chat.prompts.quickPlan"),
];

export const imagePrompts = [
  t("chat.prompts.image1"),
  t("chat.prompts.image2"),
  t("chat.prompts.image3"),
];

export const videoPrompts = [
  t("chat.prompts.video1"),
  t("chat.prompts.video2"),
  t("chat.prompts.video3"),
];

/**
 * The model's chain of thought for a message, concatenated.
 *
 * It is rendered separately from the answer: it is the model's working, not
 * its conclusion, and mixing the two in one block makes the answer harder to
 * read and the reasoning look like part of the claim.
 */
export function readReasoning(message: UIMessage): string {
  if (!Array.isArray(message.parts)) return "";
  return message.parts
    .filter((part): part is { type: "reasoning"; text: string } => part.type === "reasoning" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

export function readText(message: UIMessage): string {
  const text = message.parts
    .filter(
      (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("")
    .trim();

  if (text.length > 0) return text;

  const legacyContent = (message as { content?: unknown }).content;
  return typeof legacyContent === "string" ? legacyContent : "";
}

export function isToolPart(part: UIMessage["parts"][number]): part is ToolPart {
  return (
    typeof part.type === "string" &&
    part.type.startsWith("tool-") &&
    "toolCallId" in part &&
    "state" in part
  );
}

export function formatToolState(state: string): {
  label: string;
  variant: "secondary" | "success" | "warning" | "danger";
} {
  switch (state) {
    case "input-streaming":
      return { label: t("chat.toolState.inputStreaming"), variant: "secondary" };
    case "input-available":
      return { label: t("chat.toolState.inputAvailable"), variant: "secondary" };
    case "approval-requested":
      return { label: t("chat.toolState.approvalRequested"), variant: "warning" };
    case "approval-responded":
      return { label: t("chat.toolState.approvalResponded"), variant: "success" };
    case "output-available":
      return { label: t("chat.toolState.outputAvailable"), variant: "success" };
    case "output-error":
      return { label: t("chat.toolState.outputError"), variant: "danger" };
    case "output-denied":
      return { label: t("chat.toolState.outputDenied"), variant: "warning" };
    default:
      return { label: state, variant: "secondary" };
  }
}

export function encodeImageMessage(payload: StoredImageMessagePayload): string {
  return encodeMediaMessage(payload);
}

function decodeImageMessage(content: string): StoredImageMessagePayload | null {
  const parsed = decodeMediaMessage(content);
  return parsed?.type === "image-result" ? parsed as StoredImageMessagePayload : null;
}

export function encodeVideoMessage(payload: StoredVideoMessagePayload): string {
  return encodeMediaMessage(payload);
}

function decodeVideoMessage(content: string): StoredVideoMessagePayload | null {
  const parsed = decodeMediaMessage(content);
  return parsed?.type === "video-result" ? parsed as StoredVideoMessagePayload : null;
}

export function getFileParts(message: UIMessage): FilePart[] {
  return message.parts.filter((part): part is FilePart => part.type === "file");
}

/** The same name and size twice is one attachment, not two. */
export function dedupeAttachmentNames(names: string[]): string[] {
  return [...new Set(names.filter(Boolean))];
}

export function mapStoredMessagesToUI(messages: StoredMessage[]): {
  uiMessages: UIMessage[];
  imageMap: Record<string, string>;
  videoMap: Record<string, string>;
} {
  const imageMap: Record<string, string> = {};
  const videoMap: Record<string, string> = {};
  const uiMessages = messages.map((message) => {
    const normalizedClientMessageId =
      typeof message.clientMessageId === "string" && message.clientMessageId.trim().length > 0
        ? message.clientMessageId.trim()
        : null;
    const uiMessageId = normalizedClientMessageId ?? message.id;
    const parsedImage = decodeImageMessage(message.content);
    const parsedVideo = decodeVideoMessage(message.content);
    const parsedAssistantToolMessage = decodePersistedAssistantToolMessage(message.content);
    const parsedUserMessage = decodePersistedUserMessage(message.content);

    if (parsedImage) {
      imageMap[uiMessageId] = parsedImage.assetId ? mediaUrl(parsedImage.assetId) : parsedImage.dataUrl || "";
      return {
        id: uiMessageId,
        role: message.role,
        parts: [{ type: "text", text: parsedImage.text }],
      } satisfies UIMessage;
    }

    if (parsedVideo) {
      videoMap[uiMessageId] = parsedVideo.assetId ? mediaUrl(parsedVideo.assetId) : parsedVideo.videoUrl || "";
      return {
        id: uiMessageId,
        role: message.role,
        parts: [{ type: "text", text: parsedVideo.text }],
      } satisfies UIMessage;
    }

    if (parsedAssistantToolMessage) {
      const parts: UIMessage["parts"] = [];

      // Replayed so the next request can carry it back. Some providers reject
      // a tool-bearing request whose previous assistant turns are missing their
      // reasoning, and the stored copy is the only one that exists. The part
      // carries no visible text, so the conversation reads the same as before.
      if (parsedAssistantToolMessage.reasoning) {
        parts.push({ type: "reasoning", text: parsedAssistantToolMessage.reasoning, state: "done" } as UIMessage["parts"][number]);
      }

      if (parsedAssistantToolMessage.text) {
        parts.push({ type: "text", text: parsedAssistantToolMessage.text });
      }

      for (const tool of parsedAssistantToolMessage.tools) {
        parts.push({
          type: `tool-${tool.toolName}` as `tool-${string}`,
          toolCallId: tool.toolCallId,
          state: tool.state,
          ...(tool.input !== undefined ? { input: tool.input } : {}),
          ...(tool.output !== undefined ? { output: tool.output } : {}),
          ...(tool.errorText ? { errorText: tool.errorText } : {}),
          ...(tool.approval ? { approval: tool.approval } : {}),
        } as UIMessage["parts"][number]);
      }

      return {
        id: uiMessageId,
        role: message.role,
        ...(parsedAssistantToolMessage.documentSources?.length || parsedAssistantToolMessage.unavailableTools?.length || parsedAssistantToolMessage.documentDiagnostics
          ? { metadata: {
              ...(parsedAssistantToolMessage.documentDiagnostics ? { documentDiagnostics: parsedAssistantToolMessage.documentDiagnostics } : {}),
              ...(parsedAssistantToolMessage.documentSources?.length ? { documentSources: parsedAssistantToolMessage.documentSources } : {}),
              ...(parsedAssistantToolMessage.unavailableTools?.length ? { unavailableTools: parsedAssistantToolMessage.unavailableTools } : {}),
            } }
          : {}),
        parts: parts.length > 0 ? parts : [{ type: "text", text: t("chat.messages.toolCallFallback") }],
      } satisfies UIMessage;
    }

    if (parsedUserMessage) {
      const parts: UIMessage["parts"] = [];
      if (parsedUserMessage.text) {
        parts.push({ type: "text", text: parsedUserMessage.text });
      }
      for (const file of parsedUserMessage.files) {
        parts.push({
          type: "file",
          url: file.url,
          mediaType: file.mediaType,
          ...(file.filename ? { filename: file.filename } : {}),
        });
      }

      return {
        id: uiMessageId,
        role: message.role,
        parts: parts.length > 0 ? parts : [{ type: "text", text: t("chat.messages.attachmentOnlyFallback") }],
      } satisfies UIMessage;
    }

    return {
      id: uiMessageId,
      role: message.role,
      parts: [{ type: "text", text: message.content }],
    } satisfies UIMessage;
  });

  return { uiMessages, imageMap, videoMap };
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getMessageRoleLabel(role: UIMessage["role"]): string {
  if (role === "user") return t("chat.role.user");
  if (role === "assistant") return t("chat.role.assistant");
  return t("chat.role.system");
}
