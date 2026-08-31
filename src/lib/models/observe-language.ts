import { wrapLanguageModel, wrapEmbeddingModel, type LanguageModel, type EmbeddingModel } from "ai";
import { dataRequestContext } from "@/lib/server/data-operations";
import { getModelPreferences } from "@/lib/models/preferences";
import { availableModel } from "@/lib/models/preferences-schema";
import { canFallback, recordModelAttempt, requestPricing } from "@/lib/models/usage";

type Model = Extract<LanguageModel, { specificationVersion: "v3" }>;
type Embed = Extract<EmbeddingModel, { specificationVersion: "v3" }>;
type StreamResult = Awaited<ReturnType<Model["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;

export function observeLanguageModel(model: Model, modelId: string, alternate: (id: string) => Model) {
  const context = dataRequestContext();
  if (!context?.userId) return model;
  const userId = context.userId;
  return wrapLanguageModel({ model, middleware: {
    specificationVersion: "v3",
    async wrapGenerate({ doGenerate }) {
      const started = Date.now(), rates = await requestPricing(userId);
      try { const result = await doGenerate(); await recordModelAttempt({ userId, requestId: context.requestId, mode: "chat", modelId, started, usage: result.usage, metadata: result.providerMetadata, rate: rates[modelId] }); return result; }
      catch (error) { await recordModelAttempt({ userId, requestId: context.requestId, mode: "chat", modelId, started, error }); throw error; }
    },
    async wrapStream({ params }) {
      const preferences = await getModelPreferences(userId);
      let fallbackId = preferences.chat.fallbackId;
      const hasImages = params.prompt.some(message => message.role === "user" && message.content.some(part => part.type === "file"));
      if (params.tools?.length || fallbackId === modelId || !fallbackId || !availableModel("chat", fallbackId) || hasImages && !availableModel("chat", fallbackId)?.supportsImageInput) fallbackId = null;
      const candidates = [modelId, ...(fallbackId ? [fallbackId] : [])];
      for (let attempt = 0; attempt < candidates.length; attempt++) {
        const selected = candidates[attempt], started = Date.now();
        let reader: ReadableStreamDefaultReader<Part> | undefined;
        let finished: Extract<Part, { type: "finish" }> | undefined;
        let streamError: unknown;
        let recorded = false;
        const record = async (error?: unknown) => {
          if (recorded) return; recorded = true;
          await recordModelAttempt({ userId, requestId: context.requestId, mode: "chat", modelId: selected, started, usage: finished?.usage, metadata: finished?.providerMetadata, error, fallback: attempt > 0, rate: preferences.rates[selected] });
        };
        try {
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
  const context = dataRequestContext(); if (!context?.userId) return model;
  const userId = context.userId;
  return wrapEmbeddingModel({ model, middleware: { specificationVersion: "v3", async wrapEmbed({ doEmbed }) {
    const started = Date.now(), rates = await requestPricing(userId);
    try { const result = await doEmbed(); await recordModelAttempt({ userId, requestId: context.requestId, mode: "embedding", modelId, started, usage: result.usage, metadata: result.providerMetadata, rate: rates[modelId] }); return result; }
    catch (error) { await recordModelAttempt({ userId, requestId: context.requestId, mode: "embedding", modelId, started, error }); throw error; }
  } } });
}
