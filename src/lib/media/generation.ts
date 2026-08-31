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

export async function generateStoredMedia(userId: string, type: "image" | "video", value: unknown, signal: AbortSignal) {
  const body = type === "image" ? imageRequestSchema.parse(value) : videoRequestSchema.parse(value);
  if (body.chatId && !await db.chat.findFirst({ where: { id: body.chatId, userId }, select: { id: true } })) throw new ApiError({ code: "NOT_FOUND", message: "Conversation not found" });
  const inputs = "inputImages" in body ? body.inputImages : body.inputImage ? [body.inputImage] : [];
  const assets = await resolveImageInputs(userId, inputs);
  const model = type === "image" ? { type: "image" as const, id: resolveImageModelId(body.modelId) } : { type: "video" as const, id: resolveVideoModelId(body.modelId) };
  const modelId = model.id;
  if (assets.length && !(model.type === "image" ? imageModelSupportsImageInput(model.id) : videoModelSupportsImageInput(model.id))) throw new ApiError({ code: "VALIDATION_ERROR", message: "当前模型不支持参考图输入。" });
  const bytes = await Promise.all(assets.map(readMediaAsset));
  if (!process.env.OPENROUTER_API_KEY?.trim()) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "OpenRouter API key is not configured" });
  setupServerProxy();
  const common = { version: 1 as const, modelId, prompt: body.prompt, inputImages: assets.map(asset => ({ assetId: asset.id, mediaType: asset.mediaType as GenerationRecipe["inputImages"][number]["mediaType"] })) };
  let recipe: GenerationRecipe;
  let output: { uint8Array: Uint8Array; mediaType: string };
  if (model.type === "image") {
    recipe = { ...common, type: "image" };
    output = (await callUpstream(() => generateImage({ model: getImageModel(model.id), n: 1, abortSignal: signal,
      prompt: bytes.length ? { images: bytes, ...(body.prompt ? { text: body.prompt } : {}) } : body.prompt,
    }))).image;
  } else {
    const video = videoRequestSchema.parse(body);
    recipe = { ...common, type: "video", aspectRatio: video.aspectRatio, ...(video.duration !== undefined ? { duration: video.duration } : {}), ...(video.fps !== undefined ? { fps: video.fps } : {}) };
    output = (await callUpstream(() => experimental_generateVideo({ model: getVideoModel(model.id), n: 1, abortSignal: signal,
      prompt: bytes[0] ? { image: bytes[0], ...(body.prompt ? { text: body.prompt } : {}) } : body.prompt,
      aspectRatio: video.aspectRatio, duration: video.duration, fps: video.fps,
    }))).video;
  }
  const asset = await createMediaAsset({ userId, bytes: output.uint8Array, mediaType: output.mediaType,
    kind: type === "image" ? "generated-image" : "generated-video", modelId, description: body.prompt, generation: recipe, sourceChatId: body.chatId });
  return { modelId, asset: toMediaReference(asset) };
}
