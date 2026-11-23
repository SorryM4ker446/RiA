import type { JSONArray, LanguageModelV3Prompt, LanguageModelV3StreamPart, SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { modelRefSchema, type ModelRef } from "./preferences-schema";

const protocols = {
  deepseek: "deepseek-chat-completions-v1",
  openrouter: "openrouter-chat-completions-v1",
} as const;

const originSchema = modelRefSchema.extend({ protocol: z.enum(protocols), responseId: z.uuid().optional() });
type ReasoningOrigin = z.infer<typeof originSchema>;
export const reasoningReplaySchema = z.object({
  origin: originSchema,
  details: z.array(z.json()).min(1).transform((details): JSONArray => details).optional(),
});
export type ReasoningReplay = z.infer<typeof reasoningReplaySchema>;

export function readReasoningReplay(metadata?: SharedV3ProviderOptions): ReasoningReplay | undefined {
  if (!metadata?.riaReasoning) return;
  const parsed = originSchema.safeParse(metadata.riaReasoning);
  if (!parsed.success) return;
  const origin = parsed.data;
  if (origin.providerId === "deepseek") return { origin };
  const details = metadata?.openrouter?.reasoning_details;
  if (Array.isArray(details) && details.length) return { origin, details };
}

export function reasoningReplayMetadata(replay: ReasoningReplay): SharedV3ProviderOptions {
  return { riaReasoning: replay.origin, ...(replay.details ? { openrouter: { reasoning_details: replay.details } } : {}) };
}

export function canReplayReasoning(replay: ReasoningReplay | undefined, target?: ModelRef) {
  if (!replay || !target) return false;
  // Router, preset and rolling alias targets can change before the next call.
  if (target.providerId === "openrouter" && (target.modelId.startsWith("openrouter/")
    || target.modelId.startsWith("~") || target.modelId.includes("@preset/"))) return false;
  const { origin } = replay;
  return Boolean(origin.responseId) && origin.providerId === target.providerId
    && origin.modelId === target.modelId && origin.protocol === protocols[target.providerId];
}

export function reasoningOrigin(ref: ModelRef, responseModelId: string, responseId: string): ReasoningOrigin | undefined {
  const parsed = originSchema.safeParse({ providerId: ref.providerId, modelId: responseModelId, protocol: protocols[ref.providerId], responseId });
  return parsed.success ? parsed.data : undefined;
}

/** Record the model reported by the provider for this response. */
export function tagReasoningPart(part: LanguageModelV3StreamPart, origin?: ReasoningOrigin): LanguageModelV3StreamPart {
  if (part.type !== "reasoning-start" && part.type !== "reasoning-delta" && part.type !== "reasoning-end"
    && !(part.type === "tool-call" && part.providerMetadata?.openrouter?.reasoning_details)) return part;
  return { ...part, providerMetadata: origin ? { ...part.providerMetadata, riaReasoning: origin } : withoutReasoningReplay(part.providerMetadata) };
}

export function withoutReasoningReplay(options?: SharedV3ProviderOptions, keepDetails = false): SharedV3ProviderOptions | undefined {
  if (!options) return options;
  const { riaReasoning: _origin, ...rest } = options;
  if (!keepDetails && rest.openrouter?.reasoning_details !== undefined) {
    const { reasoning_details: _details, ...openrouter } = rest.openrouter;
    if (Object.keys(openrouter).length) rest.openrouter = openrouter;
    else delete rest.openrouter;
  }
  return Object.keys(rest).length ? rest : undefined;
}

/** Keep the assistant's text and tool sequence while projecting its provider-specific reasoning. */
export function projectReasoning<Message extends ModelMessage | LanguageModelV3Prompt[number]>(messages: Message[], ref?: ModelRef, toProvider = false): Message[] {
  return messages.flatMap(message => {
    if (message.role === "tool") {
      const content = message.content.map(part => "providerOptions" in part && part.providerOptions
        ? { ...part, providerOptions: withoutReasoningReplay(part.providerOptions) } : part);
      return [{ ...message, content, providerOptions: withoutReasoningReplay(message.providerOptions) } as Message];
    }
    if (message.role !== "assistant") return [message];
    const providerOptions = withoutReasoningReplay(message.providerOptions);
    if (typeof message.content === "string") return [{ ...message, providerOptions }];
    const responses = new Map<string, { reasoning?: JSONArray; tool?: JSONArray }>();
    const content = message.content.flatMap(part => {
      const options = "providerOptions" in part ? part.providerOptions : undefined;
      const replay = part.type === "reasoning" || part.type === "tool-call" ? readReasoningReplay(options) : undefined;
      const compatible = canReplayReasoning(replay, ref);
      if (part.type === "reasoning" && !compatible) return [];
      if (!options || (compatible && !toProvider)) return [part];
      if (compatible && replay?.details && replay.origin.responseId) {
        const id = replay.origin.responseId;
        const response = responses.get(id) ?? {};
        // These arrays are cumulative within one response. The final reasoning
        // snapshot can contain signatures that were absent on the tool call.
        if (part.type === "reasoning") response.reasoning = replay.details;
        if (part.type === "tool-call") response.tool = replay.details;
        responses.set(id, response);
      }
      return [{ ...part, providerOptions: withoutReasoningReplay(options, compatible) }];
    });
    if (!content.length) return [];
    const details = Array.from(responses.values()).flatMap(response => response.reasoning ?? response.tool ?? []);
    return [{ ...message, content, providerOptions: details.length ? { ...providerOptions, openrouter: { ...providerOptions?.openrouter, reasoning_details: details } } : providerOptions } as Message];
  });
}
