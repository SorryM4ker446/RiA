import { generateImage, experimental_generateVideo } from "ai";
import { db } from "@/db";
import { t } from "@/lib/locale";
import { getImageModel, getVideoModel } from "@/lib/ai/client";
import { imageRequestSchema, videoRequestSchema } from "@/lib/server/request-schemas";
import { ApiError, callUpstream } from "@/lib/server/api-error";
import { setupServerProxy } from "@/lib/server/proxy";
import { resolveImageInputs } from "@/lib/media/messages";
import { createMediaAsset, readMediaAsset, toMediaReference } from "@/lib/media/storage";
import type { GenerationRecipe } from "@/lib/media/generation-recipe";
import { preferredModel, getModelPreferences, modelInLibrary } from "@/lib/models/preferences";
import { getModelProvider } from "@/lib/models/providers";
import { modelRefKey, type ModelRef } from "@/lib/models/preferences-schema";
import { beginModelAttempt } from "@/lib/models/call-controls";
import { canFallback, recordModelAttempt } from "@/lib/models/usage";

export async function generateStoredMedia(type: "image" | "video", value: unknown, signal: AbortSignal, allowFallback = true) {
  const body = type === "image" ? imageRequestSchema.parse(value) : videoRequestSchema.parse(value);
  if (body.chatId && !await db.chat.findFirst({ where: { id: body.chatId }, select: { id: true } })) throw new ApiError({ code: "NOT_FOUND", message: "Conversation not found" });
  const inputs = "inputImages" in body ? body.inputImages : body.inputImage ? [body.inputImage] : [];
  const assets = await resolveImageInputs(inputs);
  let model = await preferredModel(type, body.model);
  const cached = await modelInLibrary(type, model);
  if (!cached) throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${t("lib.models.modelWord")} ${model.modelId} ${t("lib.models.removedSuffix")}` });
  const acceptsImages = (item: NonNullable<typeof cached>) => type === "image" ? item.endpointImageInput === true : item.supportsImageInput;
  if (assets.length && !acceptsImages(cached)) throw new ApiError({ code: "VALIDATION_ERROR", message: t("lib.media.noImageEndpoint") });
  const bytes = await Promise.all(assets.map(readMediaAsset));
  // Credentials are the provider's own: a library entry from a provider this
  // instance has no key for is a configuration problem, not a request to try
  // some other provider's key against the same id.
  if (!getModelProvider(model.providerId).isConfigured()) throw new ApiError({ code: "CONFIGURATION_ERROR", message: t("lib.models.providerNotConfigured") });
  setupServerProxy();
  const preferences = await getModelPreferences();
  const fallback = allowFallback ? preferences[type].fallback : null;
  const fallbackModel = fallback ? await modelInLibrary(type, fallback) : null;
  const sameAsPrimary = fallback && modelRefKey(fallback) === modelRefKey(model);
  const candidates: ModelRef[] = [model, ...(fallbackModel && fallback && !sameAsPrimary && (!assets.length || acceptsImages(fallbackModel)) ? [fallback] : [])];
  let recipe: GenerationRecipe;
  let output: { uint8Array: Uint8Array; mediaType: string } | undefined;
  for (let attempt = 0; attempt < candidates.length; attempt++) {
    model = candidates[attempt]; const started = Date.now();
    const admission = await beginModelAttempt({ mode: type, ref: model, prompt: body.prompt, fallback: attempt > 0, source: "media", signal });
    const rates = admission.rate;
    try {
      const validateModel = (authorizedModel: NonNullable<typeof cached>) => {
        if (assets.length && !acceptsImages(authorizedModel)) throw new ApiError({ code: "VALIDATION_ERROR", message: t("lib.media.noImageEndpoint") });
      };
      if (type === "image") {
        const generated = await generateImage({ model: getImageModel(model, validateModel), n: 1, abortSignal: signal, maxRetries: 0, prompt: bytes.length ? { images: bytes, ...(body.prompt ? { text: body.prompt } : {}) } : body.prompt });
        output = generated.image;
        await recordModelAttempt({ attemptId: admission.id, source: "media", mode: type, modelId: model.modelId, modelProvider: model.providerId, started, usage: generated.usage, metadata: generated.providerMetadata, fallback: attempt > 0, rate: rates });
      } else {
        const video = videoRequestSchema.parse(body);
        const generated = await experimental_generateVideo({ model: getVideoModel(model, validateModel), n: 1, abortSignal: signal, maxRetries: 0, prompt: bytes[0] ? { image: bytes[0], ...(body.prompt ? { text: body.prompt } : {}) } : body.prompt, aspectRatio: video.aspectRatio, duration: video.duration, fps: video.fps });
        output = generated.video;
        await recordModelAttempt({ attemptId: admission.id, source: "media", mode: type, modelId: model.modelId, modelProvider: model.providerId, started, metadata: generated.providerMetadata, fallback: attempt > 0, rate: rates });
      }
      break;
    } catch (error) {
      await recordModelAttempt({ attemptId: admission.id, source: "media", mode: type, modelId: model.modelId, modelProvider: model.providerId, started, error, fallback: attempt > 0 });
      if (attempt + 1 === candidates.length || !canFallback(error, signal)) await callUpstream(async () => { throw error; });
    }
  }
  if (!output) throw new ApiError({ code: "UPSTREAM_FAILED", message: t("lib.media.noOutput") });
  const common = { version: 1 as const, modelId: model.modelId, modelProvider: model.providerId, prompt: body.prompt, inputImages: assets.map(asset => ({ assetId: asset.id, mediaType: asset.mediaType as GenerationRecipe["inputImages"][number]["mediaType"] })) };
  const video = type === "video" ? videoRequestSchema.parse(body) : null;
  recipe = video ? { ...common, type: "video", aspectRatio: video.aspectRatio, ...(video.duration !== undefined ? { duration: video.duration } : {}), ...(video.fps !== undefined ? { fps: video.fps } : {}) } : { ...common, type: "image" };
  const asset = await createMediaAsset({ bytes: output.uint8Array, mediaType: output.mediaType,
    kind: type === "image" ? "generated-image" : "generated-video", modelId: model.modelId, modelProvider: model.providerId, description: body.prompt, generation: recipe, sourceChatId: body.chatId });
  return { modelId: model.modelId, modelProvider: model.providerId, asset: toMediaReference(asset) };
}
