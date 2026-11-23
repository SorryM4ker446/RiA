import type { ModelMessage, ToolResultPart } from "ai";
import { estimateImageTokens } from "@/lib/models/context-budget";
import type { ConversationImageScope, ImageRead } from "@/lib/media/conversation-images";
import { MEDIA_LIMITS } from "@/lib/media/limits-constants";
import { ASSET_ID_PATTERN } from "@/lib/media/message-codec";

type MediaStats = { count: number; encodedBytes: number; visualTokens: number };
type ImageContentPart = Extract<ToolResultPart["output"], { type: "content" }>["value"][number];
const base64Head = (data: string) => Buffer.from(data.slice(0, 87_380), "base64");
const base64Bytes = (data: string) => Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
const encoded = (bytes: number) => 4 * Math.ceil(bytes / 3);

export function stepImageStats(messages: ModelMessage[]): MediaStats {
  const stats = { count: 0, encodedBytes: 0, visualTokens: 0 };
  const add = (data: string | Uint8Array) => {
    const bytes = typeof data === "string" ? base64Bytes(data) : data.byteLength;
    stats.count++;
    stats.encodedBytes += encoded(bytes);
    stats.visualTokens += estimateImageTokens(typeof data === "string" ? base64Head(data) : data, bytes);
  };
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "file" && part.mediaType.startsWith("image/")) {
        if (typeof part.data === "string" && part.data.startsWith("data:image/")) add(part.data.slice(part.data.indexOf(",") + 1));
        else if (part.data instanceof Uint8Array) add(part.data);
      }
      if (part.type === "tool-result" && part.output.type === "content") for (const item of part.output.value) if (item.type === "image-data") add(item.data);
    }
  }
  return stats;
}

function receiptImages(part: ToolResultPart): { mediaId: string; available: boolean }[] {
  if (part.output.type !== "json") return [];
  const value = part.output.value as Partial<ImageRead> & { mediaId?: string; status?: string } | null;
  if (part.toolName === "generateImage" && value?.status === "generated" && value.mediaId && ASSET_ID_PATTERN.test(value.mediaId)) return [{ mediaId: value.mediaId, available: true }];
  if (part.toolName === "readConversationHistory" && value?.kind === "conversation-images" && Array.isArray(value.images)) {
    return value.images.slice(0, MEDIA_LIMITS.historyAttachmentCount).filter(image => image && typeof image.mediaId === "string" && ASSET_ID_PATTERN.test(image.mediaId));
  }
  return [];
}

/** Attach pixels to current-turn tool results only. Stable ids stay with every omitted picture. */
export async function prepareStepImages(messages: ModelMessage[], options: { chatId: string; supportsImages: boolean; inputTokens: number; historyAttachments?: { count: number; bytes: number }; signal?: AbortSignal; imageScope?: ConversationImageScope }) {
  const latestUser = messages.map(message => message.role).lastIndexOf("user");
  const sent = new Set<string>();
  const input = options.supportsImages ? messages : messages.map(message => message.role === "user" && Array.isArray(message.content)
    ? { ...message, content: message.content.map(part => part.type === "file" && part.mediaType.startsWith("image/")
      ? { type: "text" as const, text: "[This model cannot see the attached picture.]" } : part) } : message);
  if (options.supportsImages) for (const message of input) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (let index = 1; index < message.content.length; index++) {
      const part = message.content[index], label = message.content[index - 1];
      if (part.type !== "file" || !part.mediaType.startsWith("image/") || label.type !== "text") continue;
      const id = /^\[Image attachment, media id: (.+)\]$/.exec(label.text)?.[1];
      if (id && ASSET_ID_PATTERN.test(id)) sent.add(id);
    }
  }
  let encodedBytes = stepImageStats(input).encodedBytes;
  let remainingPixels = Math.floor(options.inputTokens * 0.4);
  let count = options.historyAttachments?.count ?? 0, bytes = options.historyAttachments?.bytes ?? 0;
  const candidates = input.slice(latestUser + 1).flatMap(message => message.role === "tool" ? message.content.flatMap(part => part.type === "tool-result" ? receiptImages(part) : []) : []);
  if (!candidates.length) return input;
  const { conversationImageData, conversationImageIds } = await import("@/lib/media/conversation-images");
  const allowed = options.supportsImages ? await conversationImageIds(options.chatId, candidates.filter(image => image.available).map(image => image.mediaId), options.imageScope) : new Set<string>();
  const result = input.slice();
  // Newer requests to inspect a picture get room first. Each comparison retains the requested order.
  for (let index = result.length - 1; index > latestUser; index--) {
    const message = result[index];
    if (message.role !== "tool") continue;
    const content = [...message.content];
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
      const part = content[partIndex];
      if (part.type !== "tool-result") continue;
      const images = receiptImages(part);
      if (!images.length) continue;
      const value: ImageContentPart[] = [];
      for (const image of images) {
        options.signal?.throwIfAborted();
        let note = !image.available ? "image unavailable in this conversation" : !options.supportsImages ? "this model cannot see images" :
          !allowed.has(image.mediaId) ? "image no longer available in this conversation" : sent.has(image.mediaId) ? "pixels already included elsewhere in this request" : "image exceeds the remaining media budget";
        const room = Math.min(MEDIA_LIMITS.historyAttachmentBytes - bytes, 3 * Math.floor((MEDIA_LIMITS.modelImageEncodedBytes - encodedBytes) / 4));
        if (allowed.has(image.mediaId) && !sent.has(image.mediaId) && count < MEDIA_LIMITS.historyAttachmentCount && room > 0 && remainingPixels > 0) {
          try {
            const data = await conversationImageData(image.mediaId, room);
            if (data) {
              const tokens = estimateImageTokens(data.bytes);
              if (tokens <= remainingPixels) {
                value.push({ type: "text", text: JSON.stringify({ mediaId: image.mediaId, imageAttached: true, ...(part.toolName === "generateImage" ? { status: "generated" } : {}) }) },
                  { type: "image-data", data: data.bytes.toString("base64"), mediaType: data.mediaType });
                sent.add(image.mediaId);
                count++;
                bytes += data.bytes.byteLength;
                encodedBytes += encoded(data.bytes.byteLength);
                remainingPixels -= tokens;
                continue;
              }
            }
          } catch { options.signal?.throwIfAborted(); note = "the saved image could not be read"; }
        }
        value.push({ type: "text", text: JSON.stringify({ mediaId: image.mediaId, imageAttached: false, note }) });
      }
      // Keep the generation receipt when no pixels reach a text-only model.
      if (part.toolName !== "generateImage" || value.some(item => item.type === "image-data")) content[partIndex] = { ...part, output: { type: "content", value } };
    }
    result[index] = { ...message, content };
  }
  return result;
}
