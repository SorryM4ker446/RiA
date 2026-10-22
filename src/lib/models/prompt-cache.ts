import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import type { ModelRef } from "@/lib/models/preferences-schema";

/**
 * Anthropic models reuse a cached prompt prefix only up to an explicit
 * breakpoint; OpenAI, DeepSeek and Gemini cache prefixes on their own. Through
 * OpenRouter, Anthropic model ids start with `anthropic/`.
 */
export function needsCacheBreakpoints(ref: ModelRef): boolean {
  return ref.providerId === "openrouter" && ref.modelId.startsWith("anthropic/");
}

/**
 * Marks the end of the stable prompt parts so a later request can read them
 * from the cache: the system prompt, the end of the previous turn (the
 * conversation before this turn's message and its request context block),
 * and the end of this request, which the next step of a tool loop extends.
 * Anthropic accepts at most four breakpoints; this sets at most three.
 */
export function withCacheBreakpoints(prompt: LanguageModelV3Prompt): LanguageModelV3Prompt {
  const lastIndex = (role: LanguageModelV3Prompt[number]["role"]) => {
    for (let index = prompt.length - 1; index >= 0; index--) if (prompt[index].role === role) return index;
    return -1;
  };
  const latestUser = lastIndex("user");
  const marks = new Set([
    lastIndex("system"),
    latestUser > 0 && prompt[latestUser - 1].role !== "system" ? latestUser - 1 : -1,
    prompt.length - 1,
  ].filter(index => index >= 0));
  return prompt.map((message, index) => marks.has(index)
    ? { ...message, providerOptions: { ...message.providerOptions, openrouter: { ...message.providerOptions?.openrouter, cacheControl: { type: "ephemeral" } } } }
    : message);
}
