import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "@/db";
import { isSupportedImageModelId, isSupportedVideoModelId } from "@/config/model";
import { ApiError } from "@/lib/server/api-error";
import { pageResult, readPageOptions } from "@/lib/server/pagination";
import { getMediaAsset } from "@/lib/media/storage";
import { mediaUrl } from "@/lib/media/message-codec";
import { readGenerationRecipe } from "@/lib/media/generation-recipe";

const filters = z.strictObject({ type: z.enum(["all", "image", "video"]).default("all"), kind: z.enum(["all", "attachment", "generated-image", "generated-video"]).default("all"), usage: z.enum(["all", "referenced", "unused"]).default("all") });
export async function listMediaLibrary(userId: string, params: URLSearchParams) {
  for (const key of new Set(params.keys())) if (params.getAll(key).length > 1) throw new ApiError({ code: "VALIDATION_ERROR", message: "Duplicate query parameter" });
  const pagination = new URLSearchParams();
  for (const key of ["cursor", "limit"]) if (params.has(key)) pagination.set(key, params.get(key)!);
  const query = filters.parse(Object.fromEntries([...params].filter(([key]) => !["cursor", "limit"].includes(key))));
  const scope = `media:${createHash("sha256").update(JSON.stringify([userId, query])).digest("hex")}`;
  const options = readPageOptions(pagination, scope, 24);
  const cursor = options.cursor;
  const rows = await db.mediaAsset.findMany({ where: {
    userId, deletedAt: null,
    ...(query.type === "all" ? {} : { mediaType: { startsWith: `${query.type}/` } }),
    ...(query.kind === "all" ? {} : { kind: query.kind }),
    AND: [
      ...(query.usage === "unused" ? [{ references: { none: {} }, usedByGenerations: { none: {} } }] : query.usage === "referenced" ? [{ OR: [{ references: { some: {} } }, { usedByGenerations: { some: {} } }] }] : []),
      ...(cursor ? [{ OR: [{ createdAt: { lt: cursor.date } }, { createdAt: cursor.date, id: { lt: cursor.id } }] }] : []),
    ],
  }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: options.limit + 1,
  select: { id: true, mediaType: true, byteSize: true, kind: true, modelId: true, description: true, createdAt: true, _count: { select: { references: true, usedByGenerations: true } } } });
  const page = pageResult(rows, options, scope, row => row.createdAt);
  return { ...page, data: page.data.map(({ _count, ...asset }) => ({ ...asset, url: mediaUrl(asset.id), referenceCount: _count.references + _count.usedByGenerations })) };
}

export async function getMediaDetail(userId: string, id: string) {
  const asset = await getMediaAsset(userId, id);
  const recipe = readGenerationRecipe(asset.generation);
  const [source, references, consumers, count] = await Promise.all([
    asset.sourceChatId ? db.chat.findFirst({ where: { id: asset.sourceChatId, userId }, select: { id: true, title: true, archived: true } }) : null,
    db.messageMedia.findMany({ where: { assetId: id, message: { chat: { userId } } }, take: 10, orderBy: { messageId: "asc" }, select: { message: { select: { id: true, chat: { select: { id: true, title: true, archived: true } } } } } }),
    db.mediaGenerationInput.findMany({ where: { inputAssetId: id, asset: { userId } }, take: 10, orderBy: { assetId: "asc" }, select: { assetId: true } }),
    db.mediaAsset.findUniqueOrThrow({ where: { id }, select: { _count: { select: { references: true, usedByGenerations: true } } } }),
  ]);
  let regenerationUnavailable: string | null = null;
  if (!recipe || asset.kind !== `generated-${recipe.type}`) regenerationUnavailable = "此资源没有完整生成参数，无法重新生成。旧资源不会推测参数。";
  else if (!(recipe.type === "image" ? isSupportedImageModelId(recipe.modelId) : isSupportedVideoModelId(recipe.modelId))) regenerationUnavailable = "原模型已不在当前模型目录中，无法按原参数重新生成。";
  else {
    const ids = [...new Set(recipe.inputImages.map(image => image.assetId))];
    if (await db.mediaAsset.count({ where: { id: { in: ids }, userId, deletedAt: null } }) !== ids.length) regenerationUnavailable = "原参考图已不可用，无法按原参数重新生成。";
  }
  return { id: asset.id, url: mediaUrl(id), mediaType: asset.mediaType, byteSize: asset.byteSize, kind: asset.kind, modelId: asset.modelId, description: asset.description, createdAt: asset.createdAt, generation: recipe,
    sourceChat: source, references: references.map(ref => ({ messageId: ref.message.id, chat: ref.message.chat })), usedByGenerations: consumers.map(ref => ref.assetId),
    messageReferenceCount: count._count.references, generationReferenceCount: count._count.usedByGenerations, regenerationUnavailable };
}
