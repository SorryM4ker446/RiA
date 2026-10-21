import { ApiError } from "@/lib/server/api-error";

export type ContextCapacity = { contextLength?: number | null; maxOutputTokens?: number | null };
export const CONTEXT_COUNTING = "character-class-estimate" as const;
export type ContextBudget = {
  contextWindow: number;
  capacitySource: "catalog" | "configured" | "unknown";
  outputTokens: number;
  safetyTokens: number;
  inputTokens: number;
  triggerTokens: number;
  targetTokens: number;
  counting: typeof CONTEXT_COUNTING;
};

/** Unknown capacity is an application planning ceiling, never a model capability claim. */
export function contextBudget(model?: ContextCapacity | null, configured?: ContextCapacity): ContextBudget {
  const knownWindow = Math.min(configured?.contextLength ?? Infinity, model?.contextLength ?? Infinity);
  const contextWindow = Number.isFinite(knownWindow) ? knownWindow : 131_072;
  const safetyTokens = Math.max(32, Math.ceil(contextWindow * 0.05));
  const outputTokens = Math.max(1, Math.min(configured?.maxOutputTokens ?? Math.min(8192, Math.floor(contextWindow / 4)), model?.maxOutputTokens ?? Infinity, contextWindow - safetyTokens - 512));
  const inputTokens = Math.max(0, contextWindow - outputTokens - safetyTokens);
  return { contextWindow, capacitySource: configured?.contextLength ? "configured" : model?.contextLength ? "catalog" : "unknown",
    outputTokens, safetyTokens, inputTokens, triggerTokens: Math.floor(inputTokens * 0.75), targetTokens: Math.floor(inputTokens * 0.5), counting: CONTEXT_COUNTING };
}

const LOWER = 1, UPPER = 2, DIGIT = 3, OTHER = 4;

/**
 * Upper-bound planning estimate that does not depend on a provider tokenizer.
 *
 * Runs of lowercase letters and spaces cost a token per four characters, runs
 * of capitals one per two; digits, punctuation and control characters cost one
 * each. Non-ASCII characters cost half a token per UTF-8 byte, and characters
 * outside the Basic Multilingual Plane four tokens. Every run is rounded up, so
 * mixed-case random text such as base64 is not undercounted. Against the
 * cl100k and o200k encodings this overestimates prose, code and JSON by about
 * 1.7-2x and Chinese by about 1.6x, rather than the 3-5x of counting bytes.
 */
export function estimateTextTokens(text: string): number {
  let tokens = 0, run = 0, kind = 0;
  const flush = () => {
    if (run) tokens += kind === LOWER ? Math.ceil(run / 4) : kind === UPPER ? Math.ceil(run / 2) : run;
    run = 0;
  };
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 128) {
      flush(); kind = 0;
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) { index++; tokens += 4; }
      else tokens += code < 0x800 ? 1 : 1.5;
      continue;
    }
    const next = (code >= 97 && code <= 122) || code === 32 ? LOWER : code >= 65 && code <= 90 ? UPPER : code >= 48 && code <= 57 ? DIGIT : OTHER;
    if (next !== kind) { flush(); kind = next; }
    run++;
  }
  flush();
  return Math.ceil(tokens);
}

/**
 * Serialized request text plus framing, times a calibration scale of at least
 * one. Binary attachments count one token per byte: no local tokenizer can
 * price provider-specific image or document encoding.
 */
export function estimateContextTokens(value: unknown, scale = 1): number {
  let binaryBytes = 0;
  const encoded = JSON.stringify(value, (_key, item) => {
    if (item instanceof Uint8Array) { binaryBytes += item.byteLength; return `[binary attachment: ${item.byteLength} bytes]`; }
    return item;
  });
  return Math.ceil((estimateTextTokens(encoded ?? "") + binaryBytes + 256) * Math.max(1, scale));
}

export function assertContextFits(budget: ContextBudget, input: unknown, scale = 1) {
  const estimatedInputTokens = estimateContextTokens(input, scale);
  if (estimatedInputTokens > budget.inputTokens) throw new ApiError({
    code: "CONTEXT_LIMIT",
    message: "The required context exceeds this model's input budget. Use a larger-context model or reduce the current input or attachments. Saved execution records have been preserved.",
    details: { ...budget, estimatedInputTokens },
  });
  return estimatedInputTokens;
}
