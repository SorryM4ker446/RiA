import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { observeLanguageModel, observeEmbeddingModel } from "@/lib/models/observe-language";
import { wrapImageModel } from "ai";
import { withModelLease } from "@/lib/models/preferences";
import type { ModelLibraryItem } from "@/lib/models/preferences-schema";

type ModelValidator = (model: ModelLibraryItem) => void;

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

export function getChatModel(modelId: string) {
  return observeLanguageModel(openrouter(modelId), modelId, id => openrouter(id));
}

export function getEmbeddingModel(modelId: string) {
  return observeEmbeddingModel(openrouter.textEmbeddingModel(modelId), modelId);
}

export function getImageModel(modelId: string, validate?: ModelValidator) {
  return wrapImageModel({
    model: openrouter.imageModel(modelId),
    middleware: {
      specificationVersion: "v3",
      async wrapGenerate({ doGenerate }) {
        return withModelLease("image", modelId, model => {
          validate?.(model);
          return doGenerate();
        });
      },
    },
  });
}

export function getVideoModel(modelId: string, validate?: ModelValidator) {
  const model = openrouter.videoModel(modelId);
  return {
    ...model,
    async doGenerate(options: Parameters<typeof model.doGenerate>[0]) {
      return withModelLease("video", modelId, async authorizedModel => {
        validate?.(authorizedModel);
        return model.doGenerate(options);
      });
    },
  };
}
