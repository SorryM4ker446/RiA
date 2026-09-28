import { z } from "zod";
import { APICallError, InvalidResponseDataError, type LanguageModelV3, type LanguageModelV3CallOptions, type LanguageModelV3Content, type LanguageModelV3FinishReason, type LanguageModelV3GenerateResult, type LanguageModelV3Prompt, type LanguageModelV3StreamPart, type LanguageModelV3ToolResultOutput, type LanguageModelV3Usage, type SharedV3Warning } from "@ai-sdk/provider";
import { createEventSourceResponseHandler, postJsonToApi } from "@ai-sdk/provider-utils";

/**
 * DeepSeek's official chat API, spoken directly.
 *
 * The endpoint is OpenAI-shaped, which is exactly the trap: pointing an
 * OpenAI-shaped SDK at a different base URL produces a client that appears to
 * work and then fails on the parts that are not OpenAI-shaped. Three of those
 * parts are load-bearing here and are implemented rather than assumed:
 *
 * 1. Thinking mode is **on by default** server-side, and while it is on the API
 *    rejects `required` and named `tool_choice` with a 400. Passing one through
 *    because "every OpenAI client does" would break the tool loop.
 * 2. `reasoning_content` is the chain of thought, carried alongside `content`.
 *    When a request carries tools, the API requires the reasoning of prior
 *    assistant turns to be sent back or it returns 400. Reasoning produced in
 *    this run therefore has to travel back out with the next request.
 * 3. Usage arrives on the last streamed chunk rather than in a separate
 *    usage-only chunk, and reports cache hits separately.
 *
 * A fourth one applies to input: images travel as OpenAI-compatible
 * `image_url` blocks carrying a data URL, in user messages only.
 *
 * Sources, verified 2026-09-28:
 *   https://api-docs.deepseek.com/api/create-chat-completion/
 *   https://api-docs.deepseek.com/guides/thinking_mode/
 *   https://api-docs.deepseek.com/guides/vision
 *   https://api-docs.deepseek.com/api/list-models/
 */

/** The formats the provider detects from the file's own content. */
const supportedImageTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/**
 * Endpoint override, for a proxy or for an offline fixture speaking the same
 * wire format. It changes where the request goes, never what it means, and it
 * carries no credential: the key is still the provider's own.
 */
export function deepSeekBaseURL() {
  const override = process.env.DEEPSEEK_BASE_URL?.trim();
  if (!override) return DEEPSEEK_BASE_URL;
  return override.replace(/\/+$/, "");
}

const modelId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][\w.-]{0,199}$/);
const toolId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);

const completionChunk = z.object({
  id: z.string().nullish(),
  model: z.string().nullish(),
  choices: z.array(z.object({
    index: z.number(),
    finish_reason: z.string().nullish(),
    delta: z.object({
      role: z.string().nullish(),
      content: z.string().nullish(),
      reasoning_content: z.string().nullish(),
      tool_calls: z.array(z.object({
        index: z.number(),
        id: z.string().nullish(),
        type: z.string().nullish(),
        function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }).nullish(),
      })).nullish(),
    }).nullish(),
  })),
  usage: z.object({
    prompt_tokens: z.number().nullish(),
    completion_tokens: z.number().nullish(),
    prompt_cache_hit_tokens: z.number().nullish(),
    prompt_cache_miss_tokens: z.number().nullish(),
    total_tokens: z.number().nullish(),
  }).nullish(),
}).passthrough();

const completion = z.object({
  id: z.string().nullish(),
  model: z.string().nullish(),
  choices: z.array(z.object({
    index: z.number(),
    finish_reason: z.string().nullish(),
    message: z.object({
      role: z.string().nullish(),
      content: z.string().nullish(),
      reasoning_content: z.string().nullish(),
      tool_calls: z.array(z.object({
        id: z.string(),
        type: z.string().nullish(),
        function: z.object({ name: z.string(), arguments: z.string() }),
      })).nullish(),
    }).nullish(),
  })),
  usage: z.object({
    prompt_tokens: z.number().nullish(),
    completion_tokens: z.number().nullish(),
    prompt_cache_hit_tokens: z.number().nullish(),
    prompt_cache_miss_tokens: z.number().nullish(),
  }).nullish(),
}).passthrough();

export type DeepSeekThinking = { enabled: boolean; effort?: "low" | "high" | "max" };

export type DeepSeekProviderOptions = {
  deepseek?: {
    /**
     * Thinking mode. Omitted, the server default applies (enabled). The
     * reasoning effort is only sent when thinking is on, because `none` and an
     * explicit disabled toggle are two ways of saying the same thing and
     * sending both is how a request ends up rejected.
     */
    thinking?: DeepSeekThinking;
  };
};

function readThinking(options: LanguageModelV3CallOptions, fallback: DeepSeekThinking): DeepSeekThinking {
  const raw = (options.providerOptions as DeepSeekProviderOptions | undefined)?.deepseek?.thinking;
  if (!raw) return fallback;
  return raw.enabled ? { enabled: true, ...(raw.effort ? { effort: raw.effort } : {}) } : { enabled: false };
}

function toUsage(usage: z.infer<typeof completion>["usage"]): LanguageModelV3Usage {
  const input = usage?.prompt_tokens ?? undefined;
  const cacheRead = usage?.prompt_cache_hit_tokens ?? undefined;
  const noCache = usage?.prompt_cache_miss_tokens ?? (input !== undefined && cacheRead !== undefined ? input - cacheRead : undefined);
  return {
    inputTokens: { total: input, noCache, cacheRead, cacheWrite: undefined },
    outputTokens: { total: usage?.completion_tokens ?? undefined, text: usage?.completion_tokens ?? undefined, reasoning: undefined },
  };
}

function toFinishReason(raw: string | null | undefined, hasToolCalls: boolean): LanguageModelV3FinishReason {
  const reason = raw ?? undefined;
  if (raw === "length") return { unified: "length", raw: reason };
  if (raw === "content_filter") return { unified: "content-filter", raw: reason };
  if (raw === "tool_calls" || hasToolCalls) return { unified: "tool-calls", raw: reason };
  if (raw === "insufficient_system_resource") return { unified: "error", raw: reason };
  if (raw === "stop") return { unified: "stop", raw: reason };
  return { unified: "other", raw: reason ?? "unknown" };
}

type DeepSeekMessage = Record<string, unknown> & { role: string };

/**
 * The prompt is rebuilt rather than reshaped in place because the reasoning a
 * prior turn produced has to ride back on the same assistant message that
 * carried its text. Dropping it is what makes tool conversations fail with a
 * 400, and it is invisible until a tool actually runs.
 */
function toMessages(prompt: LanguageModelV3Prompt, carriesTools: boolean): DeepSeekMessage[] {
  const messages: DeepSeekMessage[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      messages.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "user") {
      const blocks: Record<string, unknown>[] = [];
      for (const part of message.content) {
        if (part.type === "text") { blocks.push({ type: "text", text: part.text }); continue; }
        if (part.type === "file") blocks.push({ type: "image_url", image_url: { url: toImageUrl(part) } });
      }
      // A message with no attachment stays a plain string, which is what the
      // provider expects and what every text-only turn has been.
      const textOnly = blocks.every(block => block.type === "text");
      messages.push({
        role: "user",
        content: textOnly ? blocks.map(block => String(block.text)).join("\n") : blocks,
      });
      continue;
    }
    if (message.role === "assistant") {
      let text = "";
      let reasoning: string | undefined;
      const toolCalls: Record<string, unknown>[] = [];
      for (const part of message.content) {
        // The provider rejects an image outside a user message with a 400, so
        // an assistant turn that carried one keeps its text and loses the image
        // rather than failing the whole request.
        if (part.type === "file") continue;
        if (part.type === "text") text += part.text;
        else if (part.type === "reasoning") reasoning = `${reasoning ?? ""}${part.text}`;
        else if (part.type === "tool-call") {
          // A prompt carries parsed arguments, while a result carries the raw
          // string the provider sent. Re-serializing the latter would quote it
          // and hand the model a tool call whose arguments are a JSON string.
          const raw = typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {});
          toolCalls.push({ id: part.toolCallId, type: "function", function: { name: part.toolName, arguments: raw } });
        }
      }
      const assistant: DeepSeekMessage = { role: "assistant", content: text };
      if (reasoning) assistant.reasoning_content = reasoning;
      else if (carriesTools) {
        // The contract only requires reasoning to come back on a tool run. With
        // no tools it is ignored server-side, so an empty string is sent rather
        // than a fabricated one.
        assistant.reasoning_content = "";
      }
      if (toolCalls.length) assistant.tool_calls = toolCalls;
      messages.push(assistant);
      continue;
    }
    if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          messages.push({
            role: "tool",
            tool_call_id: part.toolCallId,
            content: toolResultContent(part.output),
          });
        }
      }
    }
  }
  return messages;
}

/**
 * The provider takes the image inline. A private media URL would be useless to
 * it, so anything that is not already inline data is refused with a reason
 * rather than sent as a link the provider cannot fetch.
 */
function toImageUrl(part: { mediaType: string; data: unknown }): string {
  const mediaType = part.mediaType?.toLowerCase();
  if (!mediaType || !supportedImageTypes.has(mediaType)) {
    throw new InvalidResponseDataError({ data: part.data, message: `DeepSeek chat accepts ${[...supportedImageTypes].join(", ")} images only.` });
  }
  if (typeof part.data === "string") {
    if (part.data.startsWith("data:")) return part.data;
    // Only a bare base64 payload is accepted beyond that. Anything else — an
    // http URL the provider cannot fetch, or a private path such as
    // `/api/media/…` — would otherwise be inlined as if it were image bytes.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(part.data) || part.data.length % 4 !== 0) {
      throw new InvalidResponseDataError({ data: part.data, message: "A private media URL cannot be sent to DeepSeek; the image has to be inlined." });
    }
    return `data:${mediaType};base64,${part.data}`;
  }
  if (part.data instanceof Uint8Array) {
    return `data:${mediaType};base64,${Buffer.from(part.data).toString("base64")}`;
  }
  throw new InvalidResponseDataError({ data: part.data, message: "The image could not be inlined for DeepSeek." });
}

/**
 * A tool result is a tagged value, not a bare string, and the provider wants
 * the text on its own. Stringifying the whole tag would send
 * `{"type":"text","value":"…"}` as the tool message body, which the model
 * would read as the literal result.
 */
function toolResultContent(output: LanguageModelV3ToolResultOutput): string {
  if (output.type === "text" || output.type === "error-text") return output.value;
  if (output.type === "json" || output.type === "error-json") return JSON.stringify(output.value ?? null);
  // A denied execution carries a reason rather than a result. It still has to
  // reach the model as text, otherwise the next turn sees an empty tool answer.
  return output.type === "execution-denied" ? `Tool execution was denied${output.reason ? `: ${output.reason}` : "."}` : "";
}

function toTools(options: LanguageModelV3CallOptions, thinking: DeepSeekThinking) {
  const tools = (options.tools ?? [])
    .filter(tool => tool.type === "function")
    .map(tool => {
      const value = tool as { name: string; description?: string; inputSchema: unknown; strict?: boolean };
      return {
        type: "function" as const,
        function: {
          name: value.name,
          ...(value.description ? { description: value.description } : {}),
          parameters: (value.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
        },
      };
    });
  if (tools.length === 0) return undefined;

  // Thinking mode rejects `required` and named choices. Downgrading to `auto`
  // is the documented-compatible behaviour and keeps the turn going instead of
  // failing a request the user did not shape.
  const choice = options.toolChoice;
  const supported = !thinking.enabled && choice && choice.type !== "auto" ? choice : undefined;
  if (supported?.type === "none") return { tools, tool_choice: "none" as const };
  if (supported?.type === "required") return { tools, tool_choice: "required" as const };
  if (supported?.type === "tool") return { tools, tool_choice: { type: "function" as const, function: { name: supported.toolName } } };
  return { tools, tool_choice: "auto" as const };
}

function toRequestBody(options: LanguageModelV3CallOptions, carriesTools: boolean, defaultThinking: DeepSeekThinking) {
  const thinking = readThinking(options, defaultThinking);
  const mapped = toTools(options, thinking);
  const body: Record<string, unknown> = {
    model: modelId,
    messages: toMessages(options.prompt, carriesTools),
    // Sampling parameters are documented as having no effect while thinking is
    // on, so they are only sent when it is off. Sending them anyway is
    // accepted-but-ignored noise that hides a real mistake later.
    ...(thinking.enabled ? {} : { temperature: options.temperature, top_p: options.topP }),
    ...(options.maxOutputTokens ? { max_tokens: options.maxOutputTokens } : {}),
    ...(options.stopSequences ? { stop: options.stopSequences } : {}),
    thinking: { type: thinking.enabled ? "enabled" : "disabled" },
    ...(thinking.effort ? { reasoning_effort: thinking.effort } : {}),
    ...(mapped ?? {}),
  };
  return { body, thinking };
}

function createDeepSeekChatModel(options: { modelId: string; getApiKey: () => string; baseURL?: string; fetch?: typeof fetch; defaultThinking?: DeepSeekThinking }): LanguageModelV3 {
  const baseURL = options.baseURL ?? deepSeekBaseURL();
  const defaultThinking = options.defaultThinking ?? { enabled: true };

  type PostResult = { value: unknown; responseHeaders: Record<string, string> };
  const post = async (body: Record<string, unknown>, abortSignal: AbortSignal | undefined, stream: boolean): Promise<PostResult> => {
    const apiKey = options.getApiKey();
    if (!apiKey) throw new APICallError({ message: "DeepSeek API key is not configured", url: `${baseURL}/chat/completions`, requestBodyValues: body, statusCode: undefined, isRetryable: false });
    const result = await postJsonToApi({
      url: `${baseURL}/chat/completions`,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: stream ? { ...body, stream: true, stream_options: { include_usage: true } } : { ...body, stream: false },
      abortSignal,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      // The provider's own error text is not forwarded into diagnostics: it can
      // echo the request, and this application records no prompt text anywhere.
      // The provider's error text is not forwarded into diagnostics: it can echo
      // the request, and this application records no prompt text anywhere. The
      // status code is kept, because that is what the retry and fallback rules
      // are written against.
      failedResponseHandler: async ({ response, url, requestBodyValues }) => ({
        value: new APICallError({
          message: `DeepSeek request failed with status ${response.status}`,
          url,
          requestBodyValues,
          statusCode: response.status,
          isRetryable: response.status === 429 || response.status >= 500,
        }),
        responseHeaders: Object.fromEntries(response.headers.entries()),
      }),
      successfulResponseHandler: stream
        ? createEventSourceResponseHandler(completionChunk)
        : createJsonResponseHandler(),
    });
    return { value: result.value, responseHeaders: result.responseHeaders ?? {} };
  };

  return {
    specificationVersion: "v3",
    provider: "deepseek",
    modelId: options.modelId,
    supportedUrls: {},
    async doGenerate(callOptions): Promise<LanguageModelV3GenerateResult> {
      const carriesTools = (callOptions.tools ?? []).length > 0;
      const { body } = toRequestBody(callOptions, carriesTools, defaultThinking);
      const { value, responseHeaders } = await post(body, callOptions.abortSignal, false);
      const parsed = completion.safeParse(value as unknown);
      if (!parsed.success) throw new InvalidResponseDataError({ data: value, message: "DeepSeek returned a chat completion this adapter cannot read" });
      const choice = parsed.data.choices[0];
      const content: LanguageModelV3Content[] = [];
      const reasoning = choice?.message?.reasoning_content;
      if (reasoning) content.push({ type: "reasoning", text: reasoning });
      if (choice?.message?.content) content.push({ type: "text", text: choice.message.content });
      const toolCalls = choice?.message?.tool_calls ?? [];
      for (const call of toolCalls) {
        const toolCall: LanguageModelV3Content = {
          type: "tool-call",
          toolCallId: call.id,
          toolName: call.function.name,
          // The v3 result carries the arguments as the string the provider sent,
          // not as a parsed object. An empty argument string still has to be
          // valid JSON or the SDK fails to parse the call it is about to run.
          input: call.function.arguments || "{}",
        };
        content.push(toolCall);
      }
      return {
        content,
        finishReason: toFinishReason(choice?.finish_reason, toolCalls.length > 0),
        usage: toUsage(parsed.data.usage),
        warnings: [],
        request: { body },
        response: { id: parsed.data.id ?? undefined, modelId: parsed.data.model ?? options.modelId, timestamp: new Date(), headers: responseHeaders },
      };
    },
    async doStream(callOptions) {
      const carriesTools = (callOptions.tools ?? []).length > 0;
      const { body } = toRequestBody(callOptions, carriesTools, defaultThinking);
      const { value, responseHeaders } = await post(body, callOptions.abortSignal, true);
      return {
        stream: streamResponse({ source: value as ReadableStream<unknown>, modelId: options.modelId, warnings: [] }),
        request: { body },
        response: { headers: responseHeaders },
      };
    },
  };
}

function createJsonResponseHandler() {
  return async ({ response, url, requestBodyValues }: { response: Response; url: string; requestBodyValues: unknown }) => {
    const responseBody = await response.text();
    try {
      return { responseHeaders: Object.fromEntries(response.headers.entries()), value: JSON.parse(responseBody) };
    } catch {
      throw new APICallError({ message: "DeepSeek returned a response that is not JSON", url, requestBodyValues, responseBody, statusCode: response.status, isRetryable: false });
    }
  };
}

function streamResponse(options: {
  source: ReadableStream<unknown>;
  modelId: string;
  warnings: SharedV3Warning[];
}): ReadableStream<LanguageModelV3StreamPart> {
  const { source, modelId, warnings } = options;
  const reader = source.getReader();
  let responseId: string | undefined;
  let textOpen = false;
  let reasoningOpen = false;
  let usage: LanguageModelV3Usage | undefined;
  let finishReason: LanguageModelV3FinishReason | null = null;
  let toolCallIds: string[] = [];

  /**
   * Turns one provider chunk into stream parts. Returns how many it produced.
   *
   * A chunk can legitimately produce nothing: the last chunk of a tool call
   * often carries only a finish reason, and a keep-alive can carry only an id.
   */
  function emit(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, value: unknown) {
    const chunk = completionChunk.safeParse(unwrapParsed(value));
    if (!chunk.success) {
      controller.enqueue({ type: "error", error: new InvalidResponseDataError({ data: value, message: "DeepSeek sent a stream chunk this adapter cannot read" }) });
      controller.close();
      return -1;
    }
    const parsed = chunk.data;
    let emitted = 0;
    // The id arrives with the first chunk, so the metadata is emitted then.
    // Announcing it twice would give the consumer two responses to join.
    if (parsed.id && !responseId) { responseId = parsed.id; controller.enqueue({ type: "response-metadata", id: responseId, modelId: parsed.model ?? modelId, timestamp: new Date() }); emitted += 1; }
    if (parsed.usage) usage = toUsage(parsed.usage);
    const choice = parsed.choices[0];
    if (!choice) return emitted;
    const delta = choice.delta;
    if (choice.finish_reason) finishReason = toFinishReason(choice.finish_reason, (delta?.tool_calls ?? []).length > 0);

    if (delta?.reasoning_content) {
      if (!reasoningOpen) { controller.enqueue({ type: "reasoning-start", id: "reasoning-0" }); reasoningOpen = true; emitted += 1; }
      controller.enqueue({ type: "reasoning-delta", id: "reasoning-0", delta: delta.reasoning_content });
      emitted += 1;
    }
    if (delta?.content) {
      if (!textOpen) { controller.enqueue({ type: "text-start", id: "text-0" }); textOpen = true; emitted += 1; }
      controller.enqueue({ type: "text-delta", id: "text-0", delta: delta.content });
      emitted += 1;
    }
    for (const call of delta?.tool_calls ?? []) {
      if (call.index >= toolCallIds.length) {
        const id = call.id && toolId.safeParse(call.id).success ? call.id : `call-${call.index}`;
        toolCallIds.push(id);
        controller.enqueue({ type: "tool-input-start", id, toolName: call.function?.name ?? "unknown" });
        emitted += 1;
      }
      const id = toolCallIds[call.index];
      if (call.function?.arguments) { controller.enqueue({ type: "tool-input-delta", id, delta: call.function.arguments }); emitted += 1; }
    }
    return emitted;
  }

  return new ReadableStream<LanguageModelV3StreamPart>({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings });
    },
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          closeOpen(controller, { textOpen, reasoningOpen, toolCallIds });
          textOpen = false; reasoningOpen = false; toolCallIds = [];
          // A stream that ends without a finish reason was cut off. Reporting
          // it as an ordinary stop would store a half answer as a successful
          // one, so it is surfaced as an error and the answer is not trusted.
          const ended = finishReason ?? { unified: "error" as const, raw: "stream-ended-without-finish" };
          controller.enqueue({ type: "finish", finishReason: ended, usage: usage ?? toUsage(null) });
          controller.close();
          return;
        }
        // A pull that enqueues nothing leaves the stream with no reason to ask
        // again, and the answer hangs. Keep reading here until this pull has
        // something to hand over or the provider is finished.
        if (emit(controller, value) !== 0) return;
        if (controller.desiredSize === null) return;
      }
    },
  });
}

/** `parseJsonEventStream` yields `{ success, value | error }`; only the value is the chunk. */
function unwrapParsed(value: unknown) {
  if (value && typeof value === "object" && "success" in value) {
    const parsed = value as { success: boolean; value?: unknown; error?: unknown };
    if (parsed.success) return parsed.value;
    throw parsed.error ?? new Error("DeepSeek sent a stream chunk this adapter cannot read");
  }
  return value;
}

function closeOpen(controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>, state: { textOpen: boolean; reasoningOpen: boolean; toolCallIds: string[] }) {
  if (state.textOpen) controller.enqueue({ type: "text-end", id: "text-0" });
  if (state.reasoningOpen) controller.enqueue({ type: "reasoning-end", id: "reasoning-0" });
  for (const id of state.toolCallIds) controller.enqueue({ type: "tool-input-end", id });
}

export { createDeepSeekChatModel };
