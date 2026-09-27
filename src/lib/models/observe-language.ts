import { wrapLanguageModel, wrapEmbeddingModel, type LanguageModel, type EmbeddingModel } from "ai";
import { t } from "@/lib/locale";
import { dataRequestContext } from "@/lib/server/data-operations";
import { ApiError } from "@/lib/server/api-error";
import { getModelPreferences, modelInLibrary, withModelLease } from "@/lib/models/preferences";
import { canFallback, recordModelAttempt, requestPricing } from "@/lib/models/usage";

type Model = Extract<LanguageModel, { specificationVersion: "v3" }>;
type Embed = Extract<EmbeddingModel, { specificationVersion: "v3" }>;
type StreamResult = Awaited<ReturnType<Model["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;

export function observeLanguageModel(model: Model, modelId: string, alternate: (id: string) => Model) {
  const context = dataRequestContext();
  if (!context?.workspaceId) return model;
  return wrapLanguageModel({ model, middleware: {
    specificationVersion: "v3",
    async wrapGenerate({ doGenerate }) {
      const started = Date.now();
      const rates = await requestPricing();
      try {
        const result = await withModelLease("chat", modelId, () => doGenerate());
        await recordModelAttempt({ requestId: context.requestId, mode: "chat", modelId, started, usage: result.usage, metadata: result.providerMetadata, rate: rates[modelId] });
        return result;
      } catch (error) {
        await recordModelAttempt({ requestId: context.requestId, mode: "chat", modelId, started, error });
        throw error;
      }
    },
    async wrapStream({ params }) {
      const libraryModel = await modelInLibrary("chat", modelId);
      if (!libraryModel) throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${t("lib.models.modelWord")} ${modelId} ${t("lib.models.removedSuffix")}` });
      if (params.tools?.length && !libraryModel.supportsTools) throw new ApiError({ code: "VALIDATION_ERROR", message: `${t("lib.models.chatPrefix")} ${modelId} ${t("lib.models.chatNoTools")}` });
      const hasImages = params.prompt.some(message => message.role === "user" && message.content.some(part => part.type === "file"));
      if (hasImages && !libraryModel.supportsImageInput) throw new ApiError({ code: "VALIDATION_ERROR", message: `${t("lib.models.chatPrefix")} ${modelId} ${t("lib.models.chatNoImage")}` });
      const preferences = await getModelPreferences();
      let fallbackId = preferences.chat.fallbackId;
      const fallbackModel = fallbackId ? await modelInLibrary("chat", fallbackId) : null;
      if (params.tools?.length || fallbackId === modelId || !fallbackId || !fallbackModel || hasImages && !fallbackModel.supportsImageInput) fallbackId = null;
      const candidates = [modelId, ...(fallbackId ? [fallbackId] : [])];
      for (let attempt = 0; attempt < candidates.length; attempt++) {
        const selected = candidates[attempt], started = Date.now();
        let reader: ReadableStreamDefaultReader<Part> | undefined;
        let finished: Extract<Part, { type: "finish" }> | undefined;
        let streamError: unknown;
        let recorded = false;
        const record = async (error?: unknown) => {
          if (recorded) return; recorded = true;
          await recordModelAttempt({ requestId: context.requestId, mode: "chat", modelId: selected, started, usage: finished?.usage, metadata: finished?.providerMetadata, error, fallback: attempt > 0, rate: preferences.rates[selected] });
        };
        try {
          const result = await withModelLease("chat", selected, async () => (attempt ? alternate(selected) : model).doStream(params));
          reader = result.stream.getReader();
          const buffered: Part[] = [];
          for (;;) {
            const item = await reader.read();
            if (item.done) throw new Error("Provider ended without a result");
            if (item.value.type === "error") throw item.value.error;
            if (item.value.type === "finish") {
              finished = item.value;
              if (item.value.finishReason.unified === "error") throw new Error("Provider failed before output");
            }
            buffered.push(item.value);
            if (!["stream-start", "response-metadata", "text-start", "reasoning-start"].includes(item.value.type) || buffered.length >= 32) break;
          }
          const source = reader;
          return { ...result, stream: new ReadableStream<Part>({
            start(controller) { for (const part of buffered) controller.enqueue(part); },
            async pull(controller) {
              try {
                const item = await source.read();
                if (item.done) { await record(streamError ?? (finished?.finishReason.unified === "error" || !finished ? new Error("Incomplete model stream") : undefined)); controller.close(); return; }
                if (item.value.type === "finish") finished = item.value;
                if (item.value.type === "error") streamError = item.value.error ?? new Error("Model stream failed");
                controller.enqueue(item.value);
              } catch (error) { await record(error); controller.error(error); }
            },
            async cancel(reason) { try { await source.cancel(reason); } finally { await record(new DOMException("Cancelled", "AbortError")); } },
          }) };
        } catch (error) {
          try { await reader?.cancel(); } catch { /* Preserve the original provider failure. */ }
          await record(error);
          if (attempt + 1 >= candidates.length || !canFallback(error, params.abortSignal)) throw error;
        }
      }
      throw new Error("No model candidate");
    },
  } });
}
export function observeEmbeddingModel(model: Embed, modelId: string) {
  const context = dataRequestContext();
  if (!context?.workspaceId) return model;
  return wrapEmbeddingModel({ model, middleware: { specificationVersion: "v3", async wrapEmbed({ doEmbed }) {
   const started = Date.now();
   const rates = await requestPricing();
   return withModelLease("embedding", modelId, () => doEmbed()).then(async result => {
     await recordModelAttempt({ requestId: context.requestId, mode: "embedding", modelId, started, usage: result.usage, metadata: result.providerMetadata, rate: rates[modelId] });
     return result;
   }).catch(async error => {
     await recordModelAttempt({ requestId: context.requestId, mode: "embedding", modelId, started, error });
     throw error;
   });
 } } });
}
