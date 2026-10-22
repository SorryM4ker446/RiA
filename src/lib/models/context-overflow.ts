import { ApiError } from "@/lib/server/api-error";

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }

// Wording providers use when the prompt (plus requested output) exceeds the
// model's window: OpenAI-compatible "maximum context length", Anthropic
// "prompt is too long", OpenRouter "context length", and similar.
const OVERFLOW_TEXT = /context[ _-]?(length|window)|maximum context|too many tokens|prompt is too long|input is too long|reduce the length of the (messages|input|prompt)/i;

/**
 * Whether a provider refused a request because its input did not fit the
 * model's context window. Only a provider's own refusal counts: the
 * application's planned CONTEXT_LIMIT is a deliberate decision, not a
 * miscount to recover from. Adapters that withhold error text mark the
 * classification on the error's `data` instead.
 */
export function isContextOverflow(error: unknown): boolean {
  if (error instanceof ApiError) return false;
  const value = object(error), data = object(value.data);
  if (data.contextOverflow === true || data.code === "context_length_exceeded" || object(data.error).code === "context_length_exceeded") return true;
  if (value.statusCode !== undefined && value.statusCode !== 400 && value.statusCode !== 413) return false;
  return [value.message, value.responseBody].some(text => typeof text === "string" && OVERFLOW_TEXT.test(text));
}
