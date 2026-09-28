import { wrapImageModel } from "ai";
import type { Experimental_VideoModelV3 } from "@ai-sdk/provider";
import { observeLanguageModel, observeEmbeddingModel } from "@/lib/models/observe-language";
import { withModelLease } from "@/lib/models/preferences";
import { getModelProvider } from "@/lib/models/providers";
import { ApiError } from "@/lib/server/api-error";
import { t } from "@/lib/locale";
import type { ModelLibraryItem, ModelRef } from "@/lib/models/preferences-schema";

type ModelValidator = (model: ModelLibraryItem) => void;

/**
 * The only place a provider adapter is turned into something a call site uses.
 *
 * Every entry point takes a `ModelRef` — provider plus model id — and resolves
 * the protocol here, so no route, tool or page ever names a provider. The
 * library lease rides on the returned model rather than on each call site,
 * which is what keeps a new provider from shipping without the membership check.
 *
 * A provider that does not offer a mode has no factory for it. That is a
 * refusal with a reason, not a `undefined` that surfaces as a crash later: the
 * library already keeps such a model out of the mode's selectors, so reaching
 * here means a caller asked for something the provider does not do.
 */
function requireResult<T>(value: T | undefined, mode: string): T {
  if (value) return value;
  throw new ApiError({ code: "VALIDATION_ERROR", message: `${t("lib.models.providerNoModePrefix")} ${mode} ${t("lib.models.providerNoModeSuffix")}` });
}

export function getChatModel(ref: ModelRef) {
  const provider = getModelProvider(ref.providerId);
  return observeLanguageModel(
    provider.createChatModel(ref.modelId),
    ref,
    alternate => provider.createChatModel(alternate.modelId),
  );
}

export function getEmbeddingModel(ref: ModelRef) {
  const provider = getModelProvider(ref.providerId);
  return observeEmbeddingModel(
    requireResult(provider.createEmbeddingModel?.(ref.modelId), "embedding"),
    ref,
  );
}

export function getImageModel(ref: ModelRef, validate?: ModelValidator) {
  const provider = getModelProvider(ref.providerId);
  return wrapImageModel({
    model: requireResult(provider.createImageModel?.(ref.modelId), "image"),
    middleware: {
      specificationVersion: "v3",
      async wrapGenerate({ doGenerate }) {
        return withModelLease("image", ref, model => {
          validate?.(model);
          return doGenerate();
        });
      },
    },
  });
}

export function getVideoModel(ref: ModelRef, validate?: ModelValidator) {
  const provider = getModelProvider(ref.providerId);
  const model = requireResult(provider.createVideoModel?.(ref.modelId), "video");
  return {
    ...model,
    async doGenerate(options: Parameters<Experimental_VideoModelV3["doGenerate"]>[0]) {
      return withModelLease("video", ref, authorizedModel => {
        validate?.(authorizedModel);
        return model.doGenerate(options);
      });
    },
  };
}
