import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { observeLanguageModel, observeEmbeddingModel } from "@/lib/models/observe-language";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MODEL,
  DEFAULT_VIDEO_MODEL,
  type SupportedImageModelId,
  type SupportedModelId,
  type SupportedVideoModelId,
} from "@/config/model";

const openrouterSiteName = process.env.OPENROUTER_SITE_NAME ?? process.env.OPENROUTER_X_TITLE;

const openrouter = createOpenRouter({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  headers: {
    ...(process.env.OPENROUTER_HTTP_REFERER
      ? { "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER }
      : {}),
    ...(openrouterSiteName ? { "X-OpenRouter-Title": openrouterSiteName } : {}),
  },
});

export function getChatModel(modelId: SupportedModelId = DEFAULT_MODEL) {
  return observeLanguageModel(openrouter(modelId), modelId, id => openrouter(id));
}

export const DEFAULT_EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL_ID?.trim() || "openai/text-embedding-3-small";

export function getEmbeddingModel(modelId: string = DEFAULT_EMBEDDING_MODEL) {
  return observeEmbeddingModel(openrouter.textEmbeddingModel(modelId), modelId);
}

export function getImageModel(modelId: SupportedImageModelId = DEFAULT_IMAGE_MODEL) {
  return openrouter.imageModel(modelId);
}

export function getVideoModel(modelId: SupportedVideoModelId = DEFAULT_VIDEO_MODEL) {
  return openrouter.videoModel(modelId);
}
