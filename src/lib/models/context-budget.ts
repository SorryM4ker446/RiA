import { ApiError } from "@/lib/server/api-error";

export type ContextCapacity = { contextLength?: number | null; maxOutputTokens?: number | null };
export type ContextBudget = {
  contextWindow: number;
  capacitySource: "catalog" | "configured" | "unknown";
  outputTokens: number;
  safetyTokens: number;
  inputTokens: number;
  triggerTokens: number;
  targetTokens: number;
  counting: "conservative-utf8-estimate";
};

/** Unknown capacity is an application planning ceiling, never a model capability claim. */
export function contextBudget(model?: ContextCapacity | null, configured?: ContextCapacity): ContextBudget {
  const knownWindow = Math.min(configured?.contextLength ?? Infinity, model?.contextLength ?? Infinity);
  const contextWindow = Number.isFinite(knownWindow) ? knownWindow : 131_072;
  const safetyTokens = Math.max(32, Math.ceil(contextWindow * 0.05));
  const outputTokens = Math.max(1, Math.min(configured?.maxOutputTokens ?? Math.min(8192, Math.floor(contextWindow / 4)), model?.maxOutputTokens ?? Infinity, contextWindow - safetyTokens - 512));
  const inputTokens = Math.max(0, contextWindow - outputTokens - safetyTokens);
  return { contextWindow, capacitySource: configured?.contextLength ? "configured" : model?.contextLength ? "catalog" : "unknown",
    outputTokens, safetyTokens, inputTokens, triggerTokens: Math.floor(inputTokens * 0.75), targetTokens: Math.floor(inputTokens * 0.5), counting: "conservative-utf8-estimate" };
}

/** One UTF-8 byte per estimated token plus framing. Deliberately conservative, not a bill or tokenizer. */
export function estimateContextTokens(value: unknown): number {
  let binaryBytes = 0;
  const encoded = JSON.stringify(value, (_key, item) => {
    if (item instanceof Uint8Array) { binaryBytes += item.byteLength; return `[binary attachment: ${item.byteLength} bytes]`; }
    return item;
  });
  return Buffer.byteLength(encoded ?? "", "utf8") + binaryBytes + 256;
}

export function assertContextFits(budget: ContextBudget, input: unknown) {
  const estimatedInputTokens = estimateContextTokens(input);
  if (estimatedInputTokens > budget.inputTokens) throw new ApiError({
    code: "CONTEXT_LIMIT",
    message: "The required context exceeds this model's input budget. Use a larger-context model or reduce the current input or attachments. Saved execution records have been preserved.",
    details: { ...budget, estimatedInputTokens },
  });
  return estimatedInputTokens;
}
