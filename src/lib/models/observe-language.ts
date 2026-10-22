import { wrapLanguageModel, wrapEmbeddingModel, type LanguageModel, type EmbeddingModel } from "ai";
import { t } from "@/lib/locale";
import { dataRequestContext } from "@/lib/server/data-operations";
import { ApiError } from "@/lib/server/api-error";
import { acquireModelLease, getModelPreferences, modelInLibrary, withModelLease } from "@/lib/models/preferences";
import { canFallback, recordModelAttempt } from "@/lib/models/usage";
import { modelCallSource } from "./call-context";
import { beginModelAttempt } from "./call-controls";
import { type ModelPreferences, type ModelRef } from "@/lib/models/preferences-schema";
import { modelRefKey } from "@/lib/models/preferences-schema";
import { assertContextFits, contextBudget, estimateContextTokens, MIN_CALIBRATION, requestOutputCap, type ContextBudget } from "./context-budget";
import { contextCalibration } from "./context-calibration";
import { retryDelay, waitForRetry } from "./model-retry";
import { continueTruncated } from "./continuation";

type Model = Extract<LanguageModel, { specificationVersion: "v3" }>;
type Embed = Extract<EmbeddingModel, { specificationVersion: "v3" }>;
type StreamResult = Awaited<ReturnType<Model["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;

/** Membership, persistent admission and accounting surround each provider attempt. */
export function observeLanguageModel(model: Model, ref: ModelRef, alternate: (ref: ModelRef) => Model) {
  const modelRef = ref;
  const callSource = modelCallSource();
  // Unattended calls spend a daily allowance per submitted attempt and are not retried.
  const retriable = callSource !== "scheduled";
  // A background call under a monetary ceiling is priced from its output cap. An
  // assumed default limit would price every unattended call as its maximum, so
  // with no known limit such a call is bounded by the planning reservation.
  const pricedCap = (cap: number, capacity: ContextBudget, limits: ModelPreferences["callLimits"]) =>
    capacity.outputLimit === null && callSource === "scheduled" && (limits.backgroundMaxEstimatedUsd !== null || limits.backgroundDailyEstimatedUsd !== null) ? Math.min(cap, capacity.outputTokens) : cap;
  /**
   * The output cap for one attempt on `target`. Callers that plan context (the
   * chat step manager, summaries) measure input more precisely, so this gate
   * refuses only input that cannot fit even at the lowest calibration. The cap
   * is sized from the learned calibration, which never understates the input.
   */
  const plannedCap = async (target: ModelRef, params: { prompt: unknown; tools?: unknown; maxOutputTokens?: number }) => {
    const settings = await getModelPreferences();
    const capacity = contextBudget(await modelInLibrary("chat", target), settings.contextLimits[modelRefKey(target)]);
    const input = { prompt: params.prompt, tools: params.tools };
    assertContextFits(capacity, input, MIN_CALIBRATION);
    const estimated = estimateContextTokens(input, await contextCalibration(target));
    return pricedCap(requestOutputCap(capacity, params.maxOutputTokens, estimated), capacity, settings.callLimits);
  };
  const wrapped: Model = wrapLanguageModel({ model, middleware: {
    specificationVersion: "v3",
    async wrapGenerate({ doGenerate, params }) {
      params.maxOutputTokens = await plannedCap(modelRef, params);
      const context = dataRequestContext();
      // A generated result is delivered whole, so any failure precedes output
      // and a transient one is retried as its own admitted, recorded attempt.
      for (let retries = 0; ; retries++) {
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
          const delay = admission && retriable ? retryDelay(error, retries, params.abortSignal) : null;
          if (delay === null) throw error;
          await waitForRetry(delay, params.abortSignal);
        }
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
      // Each candidate is retried after a transient failure before the next is
      // tried. Only failures before any part reaches the caller get here.
      for (let attempt = 0, retries = 0; ;) {
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
          const selectedParams = { ...params, maxOutputTokens: await plannedCap(selected, params) };
          admission = await beginModelAttempt({ mode: "chat", ref: selected, source: callSource, prompt: selectedParams.prompt, maxOutputTokens: selectedParams.maxOutputTokens, fallback: attempt > 0, signal: params.abortSignal });
          const result = await (attempt ? alternate(selected) : model).doStream(selectedParams);
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
          const observed = new ReadableStream<Part>({
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
          });
          // A continuation is a call of its own through this same wrapper:
          // admitted, recorded, retried and context-checked like any other.
          return { ...result, stream: continueTruncated(observed, params, next => wrapped.doStream(next)) };
        } catch (error) {
          try { await reader?.cancel(); } catch { /* Preserve the original provider failure. */ }
          reader?.releaseLock();
          await record(error);
          const delay = admission && retriable ? retryDelay(error, retries, params.abortSignal) : null;
          if (delay !== null) { retries++; await waitForRetry(delay, params.abortSignal); continue; }
          if (attempt + 1 >= candidates.length || !canFallback(error, params.abortSignal)) throw error;
          attempt++; retries = 0;
        }
      }
    },
  } });
  return wrapped;
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
