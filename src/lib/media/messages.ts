import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Message, Prisma } from "@prisma/client";
import type { UIMessage } from "ai";
import { db } from "@/db";
import { decodePersistedUserMessage, encodePersistedUserMessage, USER_MESSAGE_PREFIX, type PersistedFilePart } from "@/lib/ai/ui-message";
import { ApiError } from "@/lib/server/api-error";
import { MEDIA_LIMITS, attachmentValidationError } from "@/lib/media/limits";
import { assetIdFromUrl, decodeMediaMessage, encodeMediaMessage, IMAGE_MESSAGE_PREFIX, VIDEO_MESSAGE_PREFIX } from "@/lib/media/message-codec";
import { createMediaAsset, decodeImageDataUrl, getMediaAsset, readMediaAsset, toMediaReference } from "@/lib/media/storage";

export async function resolveImageInputs(userId: string, inputs: Array<{ url: string; mediaType?: string }>) {
  if (inputs.length > MEDIA_LIMITS.attachmentCount) throw new ApiError({ code: "VALIDATION_ERROR", message: "Too many image attachments" });
  const assets = [];
  for (const input of inputs) {
    const id = assetIdFromUrl(input.url);
    if (!id) throw new ApiError({ code: "VALIDATION_ERROR", message: "Upload images before using them; remote and data URLs are not accepted" });
    const asset = await getMediaAsset(userId, id);
    if (!asset.mediaType.startsWith("image/") || (input.mediaType && input.mediaType !== asset.mediaType)) throw new ApiError({ code: "VALIDATION_ERROR", message: "Image attachment type does not match" });
    assets.push(asset);
  }
  const validation = attachmentValidationError(assets.map((asset) => ({ size: asset.byteSize, type: asset.mediaType })));
  if (validation) throw new ApiError({ code: "VALIDATION_ERROR", message: validation });
  return assets;
}

export async function imageInputBytes(userId: string, inputs: Array<{ url: string; mediaType?: string }>) {
  const assets = await resolveImageInputs(userId, inputs);
  return Promise.all(assets.map(readMediaAsset));
}

async function normalizeFiles(userId: string, files: PersistedFilePart[], legacy: boolean) {
  if (files.length > MEDIA_LIMITS.attachmentCount) throw new ApiError({ code: "VALIDATION_ERROR", message: "Too many image attachments" });
  const refs = [];
  for (const file of files) {
    let id = assetIdFromUrl(file.url);
    if (!id && legacy && file.url.startsWith("data:")) {
      const decoded = decodeImageDataUrl(file.url, MEDIA_LIMITS.attachmentBytes);
      const created = await createMediaAsset({ userId, ...decoded, kind: "attachment", description: file.filename });
      id = created.id;
    }
    if (!id) throw new ApiError({ code: "VALIDATION_ERROR", message: "Attachment must reference an uploaded image" });
    const asset = await getMediaAsset(userId, id);
    refs.push({ ...toMediaReference(asset), ...(file.filename ? { filename: file.filename.slice(0, 255) } : {}) });
  }
  const validation = attachmentValidationError(refs.map((ref) => ({ size: ref.byteSize, type: ref.mediaType })));
  if (validation) throw new ApiError({ code: "VALIDATION_ERROR", message: validation });
  return refs;
}

async function importLegacyVideo(userId: string, url: string, modelId: string, description: string) {
  const match = /^\/generated-videos\/(\d+-[0-9a-f-]{36}\.(mp4|webm|mov))$/.exec(url);
  if (!match) throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid legacy video path" });
  const configured = process.env.LEGACY_VIDEO_DIRECTORY;
  if (configured && !isAbsolute(configured)) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "Legacy video directory must be absolute" });
  const directories = configured ? [configured] : [join(process.cwd(), "public", "generated-videos")];
  for (const directory of directories) {
    try {
      const root = await lstat(directory);
      if (!root.isDirectory() || root.isSymbolicLink()) continue;
      const canonical = await realpath(/* turbopackIgnore: true */ directory);
      const file = join(/* turbopackIgnore: true */ canonical, match[1]);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || await realpath(/* turbopackIgnore: true */ file) !== resolve(file) || stat.size > MEDIA_LIMITS.generatedVideoBytes) continue;
      const bytes = await readFile(/* turbopackIgnore: true */ file);
      return await createMediaAsset({ userId, bytes, mediaType: match[2] === "webm" ? "video/webm" : match[2] === "mov" ? "video/quicktime" : "video/mp4", kind: "generated-video", modelId, description });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  throw new ApiError({ code: "NOT_FOUND", message: "Legacy video file is no longer available" });
}

export async function prepareMessageMedia(userId: string, content: string, legacy = false) {
  const media = decodeMediaMessage(content);
  if (media) {
    let id = media.assetId;
    if (!id && legacy && media.type === "image-result" && media.dataUrl) {
      const decoded = decodeImageDataUrl(media.dataUrl, MEDIA_LIMITS.generatedImageBytes);
      id = (await createMediaAsset({ userId, ...decoded, kind: "generated-image", modelId: media.modelId, description: media.text })).id;
    }
    if (!id && legacy && media.type === "video-result" && media.videoUrl) id = (await importLegacyVideo(userId, media.videoUrl, media.modelId, media.text)).id;
    if (!id) throw new ApiError({ code: "VALIDATION_ERROR", message: "Generated media must reference a stored asset" });
    const asset = await getMediaAsset(userId, id);
    if (!asset.mediaType.startsWith(media.type === "image-result" ? "image/" : "video/")) throw new ApiError({ code: "VALIDATION_ERROR", message: "Media type does not match the message" });
    return { content: encodeMediaMessage({ type: media.type, assetId: id, relativePath: asset.relativePath, mediaType: asset.mediaType, modelId: asset.modelId ?? media.modelId, text: media.text }), assetIds: [id] };
  }
  const userMessage = decodePersistedUserMessage(content);
  if (userMessage) {
    const files = await normalizeFiles(userId, userMessage.files, legacy);
    return { content: encodePersistedUserMessage({ ...userMessage, files }), assetIds: files.map((file) => file.assetId) };
  }
  if ([IMAGE_MESSAGE_PREFIX, VIDEO_MESSAGE_PREFIX, USER_MESSAGE_PREFIX].some((prefix) => content.startsWith(prefix))) throw new ApiError({ code: "VALIDATION_ERROR", message: "Malformed media message" });
  return { content, assetIds: [] as string[] };
}

export async function replaceMessageMedia(tx: Prisma.TransactionClient, userId: string, messageId: string, assetIds: string[]) {
  const ids = [...new Set(assetIds)];
  const owned = await tx.mediaAsset.count({ where: { id: { in: ids }, userId, deletedAt: null } });
  if (owned !== ids.length) throw new ApiError({ code: "NOT_FOUND", message: "Media asset is unavailable" });
  await tx.mediaAsset.updateMany({ where: { userId, OR: [{ id: { in: ids } }, { references: { some: { messageId } } }] }, data: { lastUsedAt: new Date() } });
  await tx.messageMedia.deleteMany({ where: { messageId } });
  if (ids.length) await tx.messageMedia.createMany({ data: ids.map((assetId) => ({ messageId, assetId })) });
}

export async function migrateMessageMedia(userId: string, message: Message): Promise<Message> {
  // Already normalized references are indexed on write. Only old embedded payloads need migration.
  const generated = decodeMediaMessage(message.content);
  const user = decodePersistedUserMessage(message.content);
  if (!(generated && !generated.assetId) && !user?.files.some((file) => file.url.startsWith("data:"))) return message;
  try {
    const prepared = await prepareMessageMedia(userId, message.content, true);
    return await db.$transaction(async (tx) => {
      const changed = await tx.message.updateMany({ where: { id: message.id, content: message.content, chat: { userId } }, data: { content: prepared.content } });
      if (changed.count === 1) await replaceMessageMedia(tx, userId, message.id, prepared.assetIds);
      return await tx.message.findUnique({ where: { id: message.id } }) ?? message;
    });
  } catch {
    // A missing old file, disk error, or oversized legacy payload must not destroy the old message.
    return message;
  }
}

export async function materializeChatAttachments(userId: string, messages: UIMessage[]) {
  // The model receives bytes read under the authenticated user, never an internal URL to fetch.
  // Keep the newest attachment window; older files remain visible in stored conversation history.
  let count = 0, bytes = 0;
  const result: UIMessage[] = [];
  for (const message of [...messages].reverse()) {
    const parts: UIMessage["parts"] = [];
    for (const part of message.parts) {
      if (part.type !== "file") { parts.push(part); continue; }
      const [asset] = await resolveImageInputs(userId, [part]);
      if (count >= MEDIA_LIMITS.attachmentCount || bytes + asset.byteSize > MEDIA_LIMITS.totalAttachmentBytes) {
        parts.push({ type: "text", text: `[Earlier image attachment omitted from model context: ${part.filename || "image"}]` });
        continue;
      }
      count += 1; bytes += asset.byteSize;
      const data = await readMediaAsset(asset);
      parts.push({ ...part, url: `data:${asset.mediaType};base64,${data.toString("base64")}` });
    }
    result.unshift({ ...message, parts });
  }
  return result;
}
