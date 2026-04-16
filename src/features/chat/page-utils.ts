import { UIMessage } from "ai";
import { decodePersistedUserMessage } from "@/lib/ai/ui-message";

export type ChatSummary = {
  id: string;
  title: string;
  lastMessageAt: string;
  messageCount: number;
};

export type StoredMessage = {
  id: string;
  clientMessageId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type ToolPart = Extract<UIMessage["parts"][number], { type: `tool-${string}` }>;
export type FilePart = Extract<UIMessage["parts"][number], { type: "file" }>;
export type ModelMode = "chat" | "image" | "video";
export type MessageStatus = "pending" | "success" | "error";

export type StoredImageMessagePayload = {
  type: "image-result";
  dataUrl: string;
  modelId: string;
  text: string;
};

export type StoredVideoMessagePayload = {
  type: "video-result";
  videoUrl: string;
  modelId: string;
  text: string;
};

export type UploadableFilePart = {
  type: "file";
  url: string;
  mediaType: string;
  filename?: string;
};

export const quickPrompts = [
  "帮我总结这段内容：",
  "把这段话改写得更专业：",
  "帮我制定一周学习计划：",
];

export const imagePrompts = [
  "赛博朋克夜景，霓虹灯雨夜，电影感构图",
  "产品海报：极简风智能手表，白底，商业摄影",
  "国风插画：山水与飞鹤，留白，高细节",
];

export const videoPrompts = [
  "清晨海边航拍镜头，电影级光影，慢速推进",
  "未来城市街头追逐，霓虹反射，动态运镜",
  "国风山水云海延时，薄雾流动，4K质感",
];

const IMAGE_MESSAGE_PREFIX = "__IMAGE_RESULT__:";
const VIDEO_MESSAGE_PREFIX = "__VIDEO_RESULT__:";

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
      return { label: "准备输入中", variant: "secondary" };
    case "input-available":
      return { label: "输入已就绪", variant: "secondary" };
    case "approval-requested":
      return { label: "等待批准", variant: "warning" };
    case "approval-responded":
      return { label: "已批准", variant: "success" };
    case "output-available":
      return { label: "执行完成", variant: "success" };
    case "output-error":
      return { label: "执行失败", variant: "danger" };
    case "output-denied":
      return { label: "已拒绝", variant: "warning" };
    default:
      return { label: state, variant: "secondary" };
  }
}

export function encodeImageMessage(payload: StoredImageMessagePayload): string {
  return `${IMAGE_MESSAGE_PREFIX}${JSON.stringify(payload)}`;
}

function decodeImageMessage(content: string): StoredImageMessagePayload | null {
  if (!content.startsWith(IMAGE_MESSAGE_PREFIX)) return null;
  const raw = content.slice(IMAGE_MESSAGE_PREFIX.length);

  try {
    const parsed = JSON.parse(raw) as StoredImageMessagePayload;
    if (
      parsed &&
      parsed.type === "image-result" &&
      typeof parsed.dataUrl === "string" &&
      typeof parsed.modelId === "string" &&
      typeof parsed.text === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function encodeVideoMessage(payload: StoredVideoMessagePayload): string {
  return `${VIDEO_MESSAGE_PREFIX}${JSON.stringify(payload)}`;
}

function decodeVideoMessage(content: string): StoredVideoMessagePayload | null {
  if (!content.startsWith(VIDEO_MESSAGE_PREFIX)) return null;
  const raw = content.slice(VIDEO_MESSAGE_PREFIX.length);

  try {
    const parsed = JSON.parse(raw) as StoredVideoMessagePayload;
    if (
      parsed &&
      parsed.type === "video-result" &&
      typeof parsed.videoUrl === "string" &&
      typeof parsed.modelId === "string" &&
      typeof parsed.text === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function getFileParts(message: UIMessage): FilePart[] {
  return message.parts.filter((part): part is FilePart => part.type === "file");
}

export function normalizePastedFiles(files: File[]): File[] {
  return files.filter((file) => file.type.startsWith("image/"));
}

export function dedupeFiles(files: File[]): File[] {
  const seen = new Set<string>();
  const result: File[] = [];

  for (const file of files) {
    const key = `${file.name}::${file.size}::${file.type}::${file.lastModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(file);
  }

  return result;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = reader.result;
      if (typeof value === "string") {
        resolve(value);
        return;
      }
      reject(new Error("Failed to read file as data URL"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export async function filesToUploadParts(files: File[]): Promise<UploadableFilePart[]> {
  const parts = await Promise.all(
    files.map(async (file) => ({
      type: "file" as const,
      url: await fileToDataUrl(file),
      mediaType: file.type || "application/octet-stream",
      ...(file.name ? { filename: file.name } : {}),
    })),
  );
  return parts;
}

export function mapStoredMessagesToUI(messages: StoredMessage[]): {
  uiMessages: UIMessage[];
  imageMap: Record<string, string>;
  videoMap: Record<string, string>;
} {
  const imageMap: Record<string, string> = {};
  const videoMap: Record<string, string> = {};
  const uiMessages = messages.map((message) => {
    const uiMessageId = message.clientMessageId ?? message.id;
    const parsedImage = decodeImageMessage(message.content);
    const parsedVideo = decodeVideoMessage(message.content);
    const parsedUserMessage = decodePersistedUserMessage(message.content);

    if (parsedImage) {
      imageMap[uiMessageId] = parsedImage.dataUrl;
      return {
        id: uiMessageId,
        role: message.role,
        parts: [{ type: "text", text: parsedImage.text }],
      } satisfies UIMessage;
    }

    if (parsedVideo) {
      videoMap[uiMessageId] = parsedVideo.videoUrl;
      return {
        id: uiMessageId,
        role: message.role,
        parts: [{ type: "text", text: parsedVideo.text }],
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
        parts: parts.length > 0 ? parts : [{ type: "text", text: "(附件消息)" }],
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
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getMessageRoleLabel(role: UIMessage["role"]): string {
  if (role === "user") return "ALTER";
  if (role === "assistant") return "RiA";
  return "系统";
}
