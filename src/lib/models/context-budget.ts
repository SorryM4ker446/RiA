import { ApiError } from "@/lib/server/api-error";

export type ContextCapacity = { contextLength?: number | null; maxOutputTokens?: number | null };
export const CONTEXT_COUNTING = "character-class-estimate" as const;
export type ContextBudget = {
  contextWindow: number;
  capacitySource: "catalog" | "configured" | "unknown";
  /** Output reserved when planning the input budget; not itself sent as a cap. */
  outputTokens: number;
  /** The configured or catalog output limit, or null when neither is known. */
  outputLimit: number | null;
  safetyTokens: number;
  inputTokens: number;
  triggerTokens: number;
  targetTokens: number;
  counting: typeof CONTEXT_COUNTING;
};

/**
 * Compaction starts when the calibrated input estimate reaches this share of the
 * input budget and folds completed work until it is back under the target.
 * Counting is calibrated from provider usage, so the trigger can sit close to
 * the budget; each step is still checked before it is sent.
 */
export const COMPACTION_TRIGGER = 0.9;
export const COMPACTION_TARGET = 0.6;

/**
 * Lowest calibration scale: the documented overestimate of the local count is
 * at most about 2x, so provider usage may lower the estimate to half and no
 * further, however small one turn's ratio (images count a token per byte).
 */
export const MIN_CALIBRATION = 0.5;

/** Unknown capacity is an application planning ceiling, never a model capability claim. */
export function contextBudget(model?: ContextCapacity | null, configured?: ContextCapacity): ContextBudget {
  const knownWindow = Math.min(configured?.contextLength ?? Infinity, model?.contextLength ?? Infinity);
  const contextWindow = Number.isFinite(knownWindow) ? knownWindow : 131_072;
  // The margin absorbs a step's estimation error, which does not grow with the
  // window: 5%, but never more than 32K tokens on very large windows.
  const safetyTokens = Math.max(32, Math.min(Math.ceil(contextWindow * 0.05), 32_768));
  const ceiling = contextWindow - safetyTokens - 512;
  const knownOutput = Math.min(configured?.maxOutputTokens ?? Infinity, model?.maxOutputTokens ?? Infinity);
  const outputLimit = Number.isFinite(knownOutput) ? Math.max(1, Math.min(knownOutput, ceiling)) : null;
  const outputTokens = Math.max(1, Math.min(configured?.maxOutputTokens ?? Math.min(8192, Math.floor(contextWindow / 4)), outputLimit ?? Infinity, ceiling));
  const inputTokens = Math.max(0, contextWindow - outputTokens - safetyTokens);
  return { contextWindow, capacitySource: configured?.contextLength ? "configured" : model?.contextLength ? "catalog" : "unknown",
    outputTokens, outputLimit, safetyTokens, inputTokens, triggerTokens: Math.floor(inputTokens * COMPACTION_TRIGGER), targetTokens: Math.floor(inputTokens * COMPACTION_TARGET), counting: CONTEXT_COUNTING };
}

/**
 * Output limit assumed when neither the catalog nor the user states one: the
 * per-call maximum of current frontier models. A model whose real limit is
 * lower needs that limit configured, or the provider rejects the call.
 */
export const DEFAULT_OUTPUT_LIMIT = 131_072;

/**
 * The output cap sent with one call.
 *
 * The planning reservation only sizes the input budget. A call may use all of
 * the output limit — known, else the default — that its actual input leaves
 * room for, and never less than the reservation. A caller's explicit, smaller
 * cap is kept.
 */
export function requestOutputCap(budget: ContextBudget, requested: number | undefined, estimatedInputTokens: number): number {
  const room = Math.max(budget.outputTokens, Math.min(budget.outputLimit ?? DEFAULT_OUTPUT_LIMIT, budget.contextWindow - budget.safetyTokens - estimatedInputTokens));
  return requested === undefined ? room : Math.min(requested, room);
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

/** Width and height from a PNG, GIF, WebP or JPEG header; null for anything else. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const u16 = (offset: number, little = false) => little ? bytes[offset] | bytes[offset + 1] << 8 : bytes[offset] << 8 | bytes[offset + 1];
  const u24 = (offset: number) => bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16;
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const result = (width: number, height: number) => width > 0 && height > 0 ? { width, height } : null;
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(1, 3) === "PNG") return result(u16(16) * 65536 + u16(18), u16(20) * 65536 + u16(22));
  if (bytes.length >= 10 && ascii(0, 4) === "GIF8") return result(u16(6, true), u16(8, true));
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const chunk = ascii(12, 4);
    if (chunk === "VP8 ") return result(u16(26, true) & 0x3fff, u16(28, true) & 0x3fff);
    if (chunk === "VP8L") return result(1 + ((bytes[22] & 0x3f) << 8 | bytes[21]), 1 + ((bytes[24] & 0x0f) << 10 | bytes[23] << 2 | (bytes[22] & 0xc0) >> 6));
    if (chunk === "VP8X") return result(1 + u24(24), 1 + u24(27));
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 9 < bytes.length;) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      // Start-of-frame markers carry the size; C4, C8 and CC are other tables.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return result(u16(offset + 7), u16(offset + 5));
      offset += 2 + u16(offset + 2);
    }
  }
  return null;
}

/**
 * Upper-bound planning estimate for one image. Providers resize before
 * encoding — the long edge is at most 2048 pixels for the common ones — and
 * the largest per-pixel rate among them is about one token per 750 pixels.
 */
export function estimateImageTokens(bytes: Uint8Array): number {
  const size = imageDimensions(bytes);
  if (!size) return bytes.byteLength;
  const shrink = Math.min(1, 2048 / Math.max(size.width, size.height));
  return Math.min(bytes.byteLength, Math.ceil(size.width * shrink * size.height * shrink / 750));
}

/**
 * Serialized request text plus framing, times a calibration scale learned from
 * provider usage and bounded below by MIN_CALIBRATION. Images are priced from
 * their dimensions; other binary attachments count one token per byte, since
 * no local tokenizer can price provider-specific document encoding.
 */
export function estimateContextTokens(value: unknown, scale = 1): number {
  let binaryTokens = 0;
  const encoded = JSON.stringify(value, (_key, item) => {
    if (item instanceof Uint8Array) { binaryTokens += estimateImageTokens(item); return `[binary attachment: ${item.byteLength} bytes]`; }
    return item;
  });
  return Math.ceil((estimateTextTokens(encoded ?? "") + binaryTokens + 256) * Math.max(MIN_CALIBRATION, scale));
}

export function assertContextFits(budget: ContextBudget, input: unknown, scale = 1) {
  return assertInputFits(budget, estimateContextTokens(input, scale));
}

/** Refuse an input measured some other way, such as from provider usage. */
export function assertInputFits(budget: ContextBudget, estimatedInputTokens: number) {
  if (estimatedInputTokens > budget.inputTokens) throw new ApiError({
    code: "CONTEXT_LIMIT",
    message: "The required context exceeds this model's input budget. Use a larger-context model or reduce the current input or attachments. Saved execution records have been preserved.",
    details: { ...budget, estimatedInputTokens },
  });
  return estimatedInputTokens;
}
