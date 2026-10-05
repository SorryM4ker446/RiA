import { wrapLanguageModel, wrapEmbeddingModel, type LanguageModel, type EmbeddingModel } from "ai";
import { t } from "@/lib/locale";
import { dataRequestContext } from "@/lib/server/data-operations";
import { ApiError } from "@/lib/server/api-error";
import { acquireModelLease, getModelPreferences, modelInLibrary, withModelLease } from "@/lib/models/preferences";
import { canFallback, recordModelAttempt } from "@/lib/models/usage";
import { modelCallSource } from "./call-context";
import { beginModelAttempt } from "./call-controls";
import { type ModelRef } from "@/lib/models/preferences-schema";

type Model = Extract<LanguageModel, { specificationVersion: "v3" }>;
type Embed = Extract<EmbeddingModel, { specificationVersion: "v3" }>;
type StreamResult = Awaited<ReturnType<Model["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;

/** Membership, persistent admission and accounting surround each provider attempt. */
export function observeLanguageModel(model: Model, ref: ModelRef, alternate: (ref: ModelRef) => Model) {
  const modelRef = ref;
  const callSource = modelCallSource();
  return wrapLanguageModel({ model, middleware: {
    specificationVersion: "v3",
    async wrapGenerate({ doGenerate, params }) {
      const context = dataRequestContext();
      const started = Date.now();
      let admission: Awaited<ReturnType<typeof beginModelAttempt>> | undefined;
      try {
        const result = await withModelLease("chat", modelRef, async () => {
          admission = await beginModelAttempt({ mode: "chat", ref: modelRef, source: callSource, prompt: params.prompt, maxOutputTokens: params.maxOutputTokens, signal: params.abortSignal });
          return doGenerate();
        });
        if (admission) await recordModelAttempt({ attemptId: admission.id, requestId: context?.requestId, mode: "chat", modelId: modelRef.modelId, modelProvider: modelRef.providerId, started, usage: result.usage, metadata: result.providerMetadata, rate: admission.rate });
        return result;
      } catch (error) {
        if (admission) await recordModelAttempt({ attemptId: admission.id, requestId: context?.requestId, mode: "chat", modelId: modelRef.modelId, modelProvider: modelRef.providerId, started, error });
        throw error;
      }
    },
    async wrapStream({ params }) {
      const libraryModel = await modelInLibrary("chat", modelRef);
      if (!libraryModel) throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${t("lib.models.modelWord")} ${modelRef.modelId} ${t("lib.models.removedSuffix")}` });
      if (params.tools?.length && !libraryModel.supportsTools) throw new ApiError({ code: "VALIDATION_ERROR", message: `${t("lib.models.chatPrefix")} ${modelRef.modelId} ${t("lib.models.chatNoTools")}` });
      const hasImages = params.prompt.some(message => message.role === "user" && message.content.some(part => part.type === "file"));
      if (hasImages && !libraryModel.supportsImageInput) throw new ApiError({ code: "VALIDATION_ERROR", message: `${t("lib.models.chatPrefix")} ${modelRef.modelId} ${t("lib.models.chatNoImage")}` });
      const preferences = await getModelPreferences();
      let fallback = preferences.chat.fallback;
      const fallbackModel = fallback ? await modelInLibrary("chat", fallback) : null;
      if (params.tools?.length || !fallback || !fallbackModel || (fallback.providerId === modelRef.providerId && fallback.modelId === modelRef.modelId) || (hasImages && !fallbackModel.supportsImageInput)) fallback = null;
      const candidates = [modelRef, ...(fallback ? [fallback] : [])];
      for (let attempt = 0; attempt < candidates.length; attempt++) {
        const selected = candidates[attempt], started = Date.now();
        let reader: ReadableStreamDefaultReader<Part> | undefined;
        let finished: Extract<Part, { type: "finish" }> | undefined;
        let streamError: unknown;
        let recorded = false;
        let admission: Awaited<ReturnType<typeof beginModelAttempt>> | undefined;
        let releaseLease: (() => Promise<void>) | undefined;
        const context = dataRequestContext();
        const record = async (error?: unknown) => {
          if (recorded) return; recorded = true;
          try {
            if (!admission) return;
            await recordModelAttempt({ attemptId: admission.id, requestId: context?.requestId, mode: "chat", modelId: selected.modelId, modelProvider: selected.providerId, started, usage: finished?.usage, metadata: finished?.providerMetadata, error, fallback: attempt > 0, rate: admission.rate });
          } finally { await releaseLease?.(); }
        };
        try {
          const lease = await acquireModelLease("chat", selected);
          releaseLease = lease.release;
          admission = await beginModelAttempt({ mode: "chat", ref: selected, source: callSource, prompt: params.prompt, maxOutputTokens: params.maxOutputTokens, fallback: attempt > 0, signal: params.abortSignal });
          const result = await (attempt ? alternate(selected) : model).doStream(params);
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
          let cancelled = false;
          return { ...result, stream: new ReadableStream<Part>({
            start(controller) { for (const part of buffered) controller.enqueue(part); },
            async pull(controller) {
              try {
                const item = await source.read();
                if (cancelled) return;
                if (item.done) { source.releaseLock(); await record(streamError ?? (finished?.finishReason.unified === "error" || !finished ? new Error("Incomplete model stream") : undefined)); controller.close(); return; }
                if (item.value.type === "finish") finished = item.value;
                if (item.value.type === "error") streamError = item.value.error ?? new Error("Model stream failed");
                controller.enqueue(item.value);
              } catch (error) {
                if (cancelled) return;
                await source.cancel(error).catch(() => undefined);
                source.releaseLock();
                await record(error); controller.error(error);
              }
            },
            async cancel(reason) { cancelled = true; try { await source.cancel(reason); } finally { source.releaseLock(); await record(new DOMException("Cancelled", "AbortError")); } },
          }) };
        } catch (error) {
          try { await reader?.cancel(); } catch { /* Preserve the original provider failure. */ }
          reader?.releaseLock();
          await record(error);
          if (attempt + 1 >= candidates.length || !canFallback(error, params.abortSignal)) throw error;
        }
      }
      throw new Error("No model candidate");
    },
  } });
}

export function observeEmbeddingModel(model: Embed, ref: ModelRef) {
  const modelRef = ref;
  return wrapEmbeddingModel({ model, middleware: { specificationVersion: "v3", async wrapEmbed({ doEmbed, params }) {
   const context = dataRequestContext();
   const started = Date.now();
   let admission: Awaited<ReturnType<typeof beginModelAttempt>> | undefined;
   return withModelLease("embedding", modelRef, async () => {
     admission = await beginModelAttempt({ mode: "embedding", ref: modelRef, prompt: params.values, source: "embedding", signal: params.abortSignal });
     return doEmbed();
   }).then(async result => {
     if (admission) await recordModelAttempt({ attemptId: admission.id, source: "embedding", requestId: context?.requestId, mode: "embedding", modelId: modelRef.modelId, modelProvider: modelRef.providerId, started, usage: result.usage, metadata: result.providerMetadata, rate: admission!.rate });
     return result;
   }).catch(async error => {
     if (admission) await recordModelAttempt({ attemptId: admission.id, source: "embedding", requestId: context?.requestId, mode: "embedding", modelId: modelRef.modelId, modelProvider: modelRef.providerId, started, error });
     throw error;
   });
  } } });
}
