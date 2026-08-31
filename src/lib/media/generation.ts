import { generateImage, experimental_generateVideo } from "ai";
import { db } from "@/db";
import { getImageModel, getVideoModel } from "@/lib/ai/client";
import { imageModelSupportsImageInput, resolveImageModelId, resolveVideoModelId, videoModelSupportsImageInput } from "@/config/model";
import { imageRequestSchema, videoRequestSchema } from "@/lib/server/request-schemas";
import { ApiError, callUpstream } from "@/lib/server/api-error";
import { setupServerProxy } from "@/lib/server/proxy";
import { resolveImageInputs } from "@/lib/media/messages";
import { createMediaAsset, readMediaAsset, toMediaReference } from "@/lib/media/storage";
import type { GenerationRecipe } from "@/lib/media/generation-recipe";
import { preferredModel, getModelPreferences } from "@/lib/models/preferences";
import { availableModel } from "@/lib/models/preferences-schema";
import { canFallback, recordModelAttempt } from "@/lib/models/usage";

export async function generateStoredMedia(userId: string, type: "image" | "video", value: unknown, signal: AbortSignal, allowFallback = true) {
  const body = type === "image" ? imageRequestSchema.parse(value) : videoRequestSchema.parse(value);
  if (body.chatId && !await db.chat.findFirst({ where: { id: body.chatId, userId }, select: { id: true } })) throw new ApiError({ code: "NOT_FOUND", message: "Conversation not found" });
  const inputs = "inputImages" in body ? body.inputImages : body.inputImage ? [body.inputImage] : [];
  const assets = await resolveImageInputs(userId, inputs);
  let modelId = await preferredModel(userId, type, body.modelId);
  if (assets.length && !(type === "image" ? imageModelSupportsImageInput(resolveImageModelId(modelId)) : videoModelSupportsImageInput(resolveVideoModelId(modelId)))) throw new ApiError({ code: "VALIDATION_ERROR", message: "当前模型不支持参考图输入。" });
  const bytes = await Promise.all(assets.map(readMediaAsset));
  if (!process.env.OPENROUTER_API_KEY?.trim()) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "OpenRouter API key is not configured" });
  setupServerProxy();
  const preferences = await getModelPreferences(userId);
  const fallback = allowFallback ? preferences[type].fallbackId : null;
  const candidates = [modelId, ...(fallback && fallback !== modelId && availableModel(type, fallback) && (!assets.length || availableModel(type, fallback)?.supportsImageInput) ? [fallback] : [])];
  let recipe: GenerationRecipe;
  let output: { uint8Array: Uint8Array; mediaType: string } | undefined;
  for (let attempt = 0; attempt < candidates.length; attempt++) {
    modelId = candidates[attempt]; const started = Date.now();
    try {
      if (type === "image") {
        const result = await generateImage({ model: getImageModel(resolveImageModelId(modelId)), n: 1, abortSignal: signal, maxRetries: 0,
          prompt: bytes.length ? { images: bytes, ...(body.prompt ? { text: body.prompt } : {}) } : body.prompt });
        output = result.image;
        await recordModelAttempt({ userId, mode: type, modelId, started, usage: result.usage, metadata: result.providerMetadata, fallback: attempt > 0, rate: preferences.rates[modelId] });
      } else {
        const video = videoRequestSchema.parse(body);
        const result = await experimental_generateVideo({ model: getVideoModel(resolveVideoModelId(modelId)), n: 1, abortSignal: signal, maxRetries: 0,
          prompt: bytes[0] ? { image: bytes[0], ...(body.prompt ? { text: body.prompt } : {}) } : body.prompt, aspectRatio: video.aspectRatio, duration: video.duration, fps: video.fps });
        output = result.video;
        await recordModelAttempt({ userId, mode: type, modelId, started, metadata: result.providerMetadata, fallback: attempt > 0, rate: preferences.rates[modelId] });
      }
      break;
    } catch (error) {
      await recordModelAttempt({ userId, mode: type, modelId, started, error, fallback: attempt > 0 });
      if (attempt + 1 === candidates.length || !canFallback(error, signal)) await callUpstream(async () => { throw error; });
    }
  }
  if (!output) throw new ApiError({ code: "UPSTREAM_FAILED", message: "模型没有返回媒体。" });
  const common = { version: 1 as const, modelId, prompt: body.prompt, inputImages: assets.map(asset => ({ assetId: asset.id, mediaType: asset.mediaType as GenerationRecipe["inputImages"][number]["mediaType"] })) };
  const video = type === "video" ? videoRequestSchema.parse(body) : null;
  recipe = video ? { ...common, type: "video", aspectRatio: video.aspectRatio, ...(video.duration !== undefined ? { duration: video.duration } : {}), ...(video.fps !== undefined ? { fps: video.fps } : {}) } : { ...common, type: "image" };
  const asset = await createMediaAsset({ userId, bytes: output.uint8Array, mediaType: output.mediaType,
    kind: type === "image" ? "generated-image" : "generated-video", modelId, description: body.prompt, generation: recipe, sourceChatId: body.chatId });
  return { modelId, asset: toMediaReference(asset) };
}
