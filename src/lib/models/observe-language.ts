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
import { needsCacheBreakpoints, withCacheBreakpoints } from "./prompt-cache";

type Model = Extract<LanguageModel, { specificationVersion: "v3" }>;
type Embed = Extract<EmbeddingModel, { specificationVersion: "v3" }>;
type StreamResult = Awaited<ReturnType<Model["doStream"]>>;
type Part = StreamResult["stream"] extends ReadableStream<infer T> ? T : never;
type Prompt = Parameters<Model["doStream"]>[0]["prompt"];

export type ObserveOptions = {
  /**
   * Called when the model answering changes: to the fallback when it takes
   * over, or back to the selected model when the fallback, tried first during a
   * degradation, fails. The caller re-plans the request for that model (its
   * context window and calibration) and may return the current call's prompt
   * prepared for it.
   */
  onSwitch?: (ref: ModelRef) => Promise<Prompt | undefined>;
};

const sameRef = (a: ModelRef, b: ModelRef) => a.providerId === b.providerId && a.modelId === b.modelId;
const hasImages = (prompt: Prompt) => prompt.some(message => message.role === "user" && message.content.some(part => part.type === "file"));

/**
 * How long a chat model that failed stays degraded. Within the window its calls
 * go to the fallback first, instead of every request waiting on the same
 * failure and its retries; the model is still tried if the fallback fails, and
 * is tried first again once the window ends. A success clears it early.
 */
export const DEGRADED_FOR_MS = 5 * 60_000;
type Degradation = { fallback: string; until: number };
// Shared by every request in the service; kept on globalThis so a module reload
// in development does not forget an outage.
const degradationStore = globalThis as typeof globalThis & { __riaChatDegradations?: Map<string, Degradation> };
const degradations = degradationStore.__riaChatDegradations ??= new Map<string, Degradation>();
function degradedTo(primary: ModelRef, fallback: ModelRef) {
  const key = modelRefKey(primary), entry = degradations.get(key);
  if (entry && entry.until <= Date.now()) degradations.delete(key);
  return Boolean(entry && entry.until > Date.now() && entry.fallback === modelRefKey(fallback));
}
/** Forgets every degradation. */
export function clearChatDegradations() { degradations.clear(); }

/** Membership, persistent admission and accounting surround each provider attempt. */
export function observeLanguageModel(model: Model, ref: ModelRef, alternate: (ref: ModelRef) => Model, options: ObserveOptions = {}) {
  const modelRef = ref;
  // A wrapper serves one request. `current` is the model the caller has planned
  // it for: the selected one, until the fallback takes over and keeps the rest
  // of the request, or the selected one again if the fallback fails first.
  let current: ModelRef = modelRef;
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
  /**
   * Who may answer a call, in the order they are tried. The fallback is a
   * candidate only if it can do everything the call asks of the selected model:
   * call the same tools, read the same images. Within a request the fallback
   * that took over keeps answering; across requests, while the selected model
   * is degraded, the fallback is tried first.
   */
  const candidatesFor = async (params: { prompt: Prompt; tools?: readonly unknown[] }): Promise<ModelRef[]> => {
    const configured = (await getModelPreferences()).chat.fallback;
    const fallbackModel = configured ? await modelInLibrary("chat", configured) : null;
    const fallback = configured && fallbackModel && !sameRef(configured, modelRef)
      && (!params.tools?.length || fallbackModel.supportsTools) && (!hasImages(params.prompt) || fallbackModel.supportsImageInput) ? configured : null;
    if (!fallback) return [modelRef];
    if (sameRef(current, fallback)) return [fallback];
    return degradedTo(modelRef, fallback) ? [fallback, modelRef] : [modelRef, fallback];
  };
  /** The call as the model now answering should receive it, re-planned by the caller when that model changes. */
  const switchTo = async <T extends { prompt: Prompt }>(selected: ModelRef, params: T): Promise<T> => {
    current = selected;
    const prompt = await options.onSwitch?.(selected);
    return prompt ? { ...params, prompt } : params;
  };
  /** The selected model failing over to the fallback degrades it; the selected model answering ends that. */
  const noteFallingBack = (selected: ModelRef, next: ModelRef) => {
    if (sameRef(selected, modelRef)) degradations.set(modelRefKey(modelRef), { fallback: modelRefKey(next), until: Date.now() + DEGRADED_FOR_MS });
  };
  const noteAnswered = (selected: ModelRef) => { if (sameRef(selected, modelRef)) degradations.delete(modelRefKey(modelRef)); };

  const wrapped: Model = wrapLanguageModel({ model, middleware: {
    specificationVersion: "v3",
    async wrapGenerate({ params }) {
      const candidates = await candidatesFor(params);
      const context = dataRequestContext();
      let base = params;
      // A generated result is delivered whole, so any failure precedes output:
      // a transient one is retried as its own admitted, recorded attempt, and
      // one the fallback may answer moves on to it.
      for (let attempt = 0, retries = 0; ;) {
        const selected = candidates[attempt], started = Date.now();
        const isFallback = !sameRef(selected, modelRef);
        let admission: Awaited<ReturnType<typeof beginModelAttempt>> | undefined;
        try {
          if (!sameRef(selected, current)) base = await switchTo(selected, params);
          const selectedParams = { ...base, maxOutputTokens: await plannedCap(selected, base) };
          const result = await withModelLease("chat", selected, async () => {
            admission = await beginModelAttempt({ mode: "chat", ref: selected, source: callSource, prompt: selectedParams.prompt, maxOutputTokens: selectedParams.maxOutputTokens, fallback: isFallback, signal: params.abortSignal });
            return (isFallback ? alternate(selected) : model).doGenerate(selectedParams);
          });
          if (admission) await recordModelAttempt({ attemptId: admission.id, requestId: context?.requestId, mode: "chat", modelId: selected.modelId, modelProvider: selected.providerId, started, usage: result.usage, metadata: result.providerMetadata, fallback: isFallback, rate: admission.rate });
          noteAnswered(selected);
          return result;
        } catch (error) {
          if (admission) await recordModelAttempt({ attemptId: admission.id, requestId: context?.requestId, mode: "chat", modelId: selected.modelId, modelProvider: selected.providerId, started, error, fallback: isFallback });
          const delay = admission && retriable ? retryDelay(error, retries, params.abortSignal) : null;
          if (delay !== null) { retries++; await waitForRetry(delay, params.abortSignal); continue; }
          if (attempt + 1 >= candidates.length || !canFallback(error, params.abortSignal)) throw error;
          noteFallingBack(selected, candidates[attempt + 1]);
          attempt++; retries = 0;
        }
      }
    },
    async wrapStream({ params }) {
      const libraryModel = await modelInLibrary("chat", modelRef);
      if (!libraryModel) throw new ApiError({ code: "CONFIGURATION_ERROR", message: `${t("lib.models.modelWord")} ${modelRef.modelId} ${t("lib.models.removedSuffix")}` });
      if (params.tools?.length && !libraryModel.supportsTools) throw new ApiError({ code: "VALIDATION_ERROR", message: `${t("lib.models.chatPrefix")} ${modelRef.modelId} ${t("lib.models.chatNoTools")}` });
      if (hasImages(params.prompt) && !libraryModel.supportsImageInput) throw new ApiError({ code: "VALIDATION_ERROR", message: `${t("lib.models.chatPrefix")} ${modelRef.modelId} ${t("lib.models.chatNoImage")}` });
      const candidates = await candidatesFor(params);
      // The call as sent to the model now answering; re-planned when that changes.
      let base = params;
      // Each candidate is retried after a transient failure before the next is
      // tried. Only failures before any part reaches the caller get here.
      for (let attempt = 0, retries = 0; ;) {
        const selected = candidates[attempt], started = Date.now();
        const isFallback = !sameRef(selected, modelRef);
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
            await recordModelAttempt({ attemptId: admission.id, requestId: context?.requestId, mode: "chat", modelId: selected.modelId, modelProvider: selected.providerId, started, usage: finished?.usage, metadata: finished?.providerMetadata, error, fallback: isFallback, rate: admission.rate });
          } finally { await releaseLease?.(); }
        };
        try {
          if (!sameRef(selected, current)) base = await switchTo(selected, params);
          const lease = await acquireModelLease("chat", selected);
          releaseLease = lease.release;
          const selectedParams = { ...base, maxOutputTokens: await plannedCap(selected, base),
            // Chat steps repeat their prefix across turns and tool steps, so a
            // cache write is read back; one-off generated calls are not marked.
            ...(needsCacheBreakpoints(selected) ? { prompt: withCacheBreakpoints(base.prompt) } : {}) };
          admission = await beginModelAttempt({ mode: "chat", ref: selected, source: callSource, prompt: selectedParams.prompt, maxOutputTokens: selectedParams.maxOutputTokens, fallback: isFallback, signal: params.abortSignal });
          const result = await (isFallback ? alternate(selected) : model).doStream(selectedParams);
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
          noteAnswered(selected);
          // A continuation is a call of its own through this same wrapper:
          // admitted, recorded, retried and context-checked like any other.
          return { ...result, stream: continueTruncated(observed, base, next => wrapped.doStream(next)) };
        } catch (error) {
          try { await reader?.cancel(); } catch { /* Preserve the original provider failure. */ }
          reader?.releaseLock();
          await record(error);
          const delay = admission && retriable ? retryDelay(error, retries, params.abortSignal) : null;
          if (delay !== null) { retries++; await waitForRetry(delay, params.abortSignal); continue; }
          if (attempt + 1 >= candidates.length || !canFallback(error, params.abortSignal)) throw error;
          noteFallingBack(selected, candidates[attempt + 1]);
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
