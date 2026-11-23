import { db } from "@/db";
import type { Prisma } from "@prisma/client";
import { decodePersistedAssistantToolMessage, decodePersistedUserMessage } from "@/lib/ai/ui-message";
import { ApiError } from "@/lib/server/api-error";
import { t } from "@/lib/locale";
import { ASSET_ID_PATTERN, assetIdFromUrl, decodeMediaMessage } from "./message-codec";
import { getMediaAsset, readMediaAsset } from "./storage";

export type ConversationImage = { mediaId: string; messageId: string; source: "upload" | "chat-image" | "image-mode"; name?: string };

export type ConversationImageScope = {
  through: { id: string; createdAt: Date };
  /** Images made by the replay itself, before its replacement answer is saved. */
  generated: Set<string>;
};

export function throughMessage(position?: ConversationImageScope["through"]): Prisma.MessageWhereInput {
  return position ? { OR: [{ createdAt: { lt: position.createdAt } }, { createdAt: position.createdAt, id: { lte: position.id } }] } : {};
}

/** Saved content preserves the order of attachments and tool outputs. */
export function messageImages(messageId: string, content: string): ConversationImage[] {
  const user = decodePersistedUserMessage(content);
  if (user) return user.files.flatMap(file => {
    const mediaId = file.mediaType.startsWith("image/") && assetIdFromUrl(file.url);
    return mediaId ? [{ mediaId, messageId, source: "upload" as const, name: file.filename }] : [];
  });
  const media = decodeMediaMessage(content);
  if (media?.type === "image-result" && media.assetId) return [{ mediaId: media.assetId, messageId, source: "image-mode" }];
  return decodePersistedAssistantToolMessage(content)?.tools.flatMap(tool => {
    const mediaId = (tool.output as { mediaId?: unknown } | null)?.mediaId;
    return tool.toolName === "generateImage" && tool.state === "output-available" && typeof mediaId === "string" && ASSET_ID_PATTERN.test(mediaId)
      ? [{ mediaId, messageId, source: "chat-image" as const }] : [];
  }) ?? [];
}

export async function recentConversationImages(chatId: string, through?: ConversationImageScope["through"]) {
  const rows = await db.message.findMany({
    where: { chatId, ...throughMessage(through), media: { some: { asset: { mediaType: { startsWith: "image/" } } } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 12, select: { id: true, content: true },
  });
  const seen = new Map<string, ConversationImage>();
  for (const row of rows) for (const image of messageImages(row.id, row.content)) if (!seen.has(image.mediaId)) seen.set(image.mediaId, image);
  return [...seen.values()];
}

/** Each id must belong to this conversation, including this turn's unsaved generated outputs. */
export async function conversationImageIds(chatId: string, ids: string[], scope?: ConversationImageScope) {
  if (!ids.length) return new Set<string>();
  const rows = await db.mediaAsset.findMany({
    where: { id: { in: ids }, deletedAt: null, mediaType: { startsWith: "image/" },
      OR: [{ references: { some: { message: { chatId, ...throughMessage(scope?.through) } } } },
        { kind: "generated-image", sourceChatId: chatId, ...(scope ? { id: { in: [...scope.generated] } } : {}) }] },
    select: { id: true },
  });
  return new Set(rows.map(row => row.id));
}

export type ImageRead = { kind: "conversation-images"; images: { mediaId: string; available: boolean }[] };

export async function readConversationImages(chatId: string, mediaIds: string[], scope?: ConversationImageScope): Promise<ImageRead> {
  const ids = [...new Set(mediaIds)];
  const allowed = await conversationImageIds(chatId, ids, scope);
  return { kind: "conversation-images", images: ids.map(mediaId => ({ mediaId, available: allowed.has(mediaId) })) };
}

export async function conversationImageData(mediaId: string, maxBytes: number) {
  const asset = await getMediaAsset(mediaId);
  if (!asset.mediaType.startsWith("image/")) throw new ApiError({ code: "NOT_FOUND", message: t("server.media.assetUnavailable") });
  if (asset.byteSize > maxBytes) return null;
  const bytes = await readMediaAsset(asset);
  return bytes.byteLength <= maxBytes ? { bytes, mediaType: asset.mediaType } : null;
}
