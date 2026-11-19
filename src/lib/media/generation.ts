import { generateImage, experimental_generateVideo } from "ai";
import { db } from "@/db";
import { t } from "@/lib/locale";
import { getImageModel, getVideoModel } from "@/lib/ai/client";
import { imageRequestSchema, videoRequestSchema } from "@/lib/server/request-schemas";
import { ApiError } from "@/lib/server/api-error";
import { describeProviderFailure, providerNameOf } from "@/lib/models/provider-errors";
import { setupServerProxy } from "@/lib/server/proxy";
import { resolveImageInputs } from "@/lib/media/messages";
import { createMediaAsset, readMediaAsset, toMediaReference } from "@/lib/media/storage";
import type { GenerationRecipe } from "@/lib/media/generation-recipe";
import { preferredModel, getModelPreferences, modelInLibrary, withModelSettingsLock } from "@/lib/models/preferences";
import { getModelProvider } from "@/lib/models/providers";
import { modelRefKey, type ModelRef } from "@/lib/models/preferences-schema";
import { beginModelAttempt } from "@/lib/models/call-controls";
import { canFallback, recordModelAttempt } from "@/lib/models/usage";
import { enforceRateLimit } from "@/lib/server/rate-limit";

function admitImageRequest(signal: AbortSignal) {
  return withModelSettingsLock(async () => {
    // A settings save cannot commit between reading the limit and charging the window.
    const preferences = await getModelPreferences();
    signal.throwIfAborted();
    enforceRateLimit("image", preferences.callLimits.imageRequestsPerMinute);
    return preferences;
  });
}

export async function generateStoredMedia(type: "image" | "video", value: unknown, signal: AbortSignal, { allowFallback = true, background = false } = {}) {
  const preferences = type === "image" ? await admitImageRequest(signal) : await getModelPreferences();
  const body = type === "image" ? imageRequestSchema.parse(value) : videoRequestSchema.parse(value);
  if (body.chatId && !await db.chat.findFirst({ where: { id: body.chatId }, select: { id: true } })) throw new ApiError({ code: "NOT_FOUND", message: t("server.conversation.notFound") });
  const inputs = "inputImages" in body ? body.inputImages : body.inputImage ? [body.inputImage] : [];
  const assets = await resolveImageInputs(inputs);
  const primary = await preferredModel(type, body.model);
  const cached = await modelInLibrary(type, primary);
  if (!cached) throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${t("lib.models.modelWord")} ${primary.modelId} ${t("lib.models.removedSuffix")}` });
  const acceptsInputs = (item: NonNullable<typeof cached>) =>
    !assets.length || (type === "image" ? item.endpointImageInput === true : item.supportsImageInput);
  const alternate = allowFallback ? preferences[type].fallback : null;
  const primaryKey = modelRefKey(primary);
  const alternateModel = alternate && modelRefKey(alternate) !== primaryKey ? await modelInLibrary(type, alternate) : null;
  const fallback = alternateModel && acceptsInputs(alternateModel) ? alternate : null;
  const primaryAcceptsInputs = acceptsInputs(cached);
  if (!primaryAcceptsInputs && (type === "video" || !fallback)) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: t("lib.media.noImageEndpoint") });
  }
  const candidates: ModelRef[] = [...(primaryAcceptsInputs ? [primary] : []), ...(fallback ? [fallback] : [])];
  // Credentials are the provider's own: a library entry from a provider this
  // instance has no key for is a configuration problem, not a request to try
  // some other provider's key against the same id.
  let model = candidates[0];
  if (!getModelProvider(model.providerId).isConfigured()) throw new ApiError({ code: "CONFIGURATION_ERROR", message: t("lib.models.providerNotConfigured") });
  const bytes = await Promise.all(assets.map(readMediaAsset));
  setupServerProxy();
  let recipe: GenerationRecipe;
  let output: { uint8Array: Uint8Array; mediaType: string } | undefined;
  for (let attempt = 0; attempt < candidates.length; attempt++) {
    model = candidates[attempt];
    const usedFallback = modelRefKey(model) !== primaryKey;
    const started = Date.now();
    const admission = await beginModelAttempt({ mode: type, ref: model, prompt: body.prompt, fallback: usedFallback, source: "media", background, signal });
    const rates = admission.rate;
    try {
      const validateModel = (authorizedModel: NonNullable<typeof cached>) => {
        if (!acceptsInputs(authorizedModel)) throw new ApiError({ code: "VALIDATION_ERROR", message: t("lib.media.noImageEndpoint") });
      };
      if (type === "image") {
        const aspectRatio = "aspectRatio" in body ? body.aspectRatio : undefined;
        const generated = await generateImage({ model: getImageModel(model, validateModel), n: 1, abortSignal: signal, maxRetries: 0, prompt: bytes.length ? { images: bytes, ...(body.prompt ? { text: body.prompt } : {}) } : body.prompt, ...(aspectRatio ? { aspectRatio } : {}) });
        output = generated.image;
        await recordModelAttempt({ attemptId: admission.id, source: "media", mode: type, modelId: model.modelId, modelProvider: model.providerId, started, usage: generated.usage, metadata: generated.providerMetadata, fallback: usedFallback, rate: rates });
      } else {
        const video = videoRequestSchema.parse(body);
        const generated = await experimental_generateVideo({ model: getVideoModel(model, validateModel), n: 1, abortSignal: signal, maxRetries: 0, prompt: bytes[0] ? { image: bytes[0], ...(body.prompt ? { text: body.prompt } : {}) } : body.prompt, aspectRatio: video.aspectRatio, duration: video.duration, fps: video.fps });
        output = generated.video;
        await recordModelAttempt({ attemptId: admission.id, source: "media", mode: type, modelId: model.modelId, modelProvider: model.providerId, started, metadata: generated.providerMetadata, fallback: usedFallback, rate: rates });
      }
      break;
    } catch (error) {
      await recordModelAttempt({ attemptId: admission.id, source: "media", mode: type, modelId: model.modelId, modelProvider: model.providerId, started, error, fallback: usedFallback });
      // A rejected key or a delisted model says so, and where to fix it, instead of "try again later".
      if (attempt + 1 === candidates.length || !canFallback(error, signal)) throw describeProviderFailure(error, providerNameOf(model.providerId));
    }
  }
  if (!output) throw new ApiError({ code: "UPSTREAM_FAILED", message: t("lib.media.noOutput") });
  const common = { version: 1 as const, modelId: model.modelId, modelProvider: model.providerId, prompt: body.prompt, inputImages: assets.map(asset => ({ assetId: asset.id, mediaType: asset.mediaType as GenerationRecipe["inputImages"][number]["mediaType"] })) };
  const video = type === "video" ? videoRequestSchema.parse(body) : null;
  const imageRatio = type === "image" && "aspectRatio" in body ? body.aspectRatio : undefined;
  recipe = video ? { ...common, type: "video", aspectRatio: video.aspectRatio, ...(video.duration !== undefined ? { duration: video.duration } : {}), ...(video.fps !== undefined ? { fps: video.fps } : {}) } : { ...common, type: "image", ...(imageRatio ? { aspectRatio: imageRatio } : {}) };
  const asset = await createMediaAsset({ bytes: output.uint8Array, mediaType: output.mediaType,
    kind: type === "image" ? "generated-image" : "generated-video", modelId: model.modelId, modelProvider: model.providerId, description: body.prompt, generation: recipe, sourceChatId: body.chatId });
  return { modelId: model.modelId, modelProvider: model.providerId, asset: toMediaReference(asset) };
}
