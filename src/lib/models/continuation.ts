import type { LanguageModelV3CallOptions, LanguageModelV3Prompt, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";

/** Follow-up requests one cut-off answer may chain; each gets a full output cap. */
export const MAX_CONTINUATIONS = 3;
export const CONTINUE_INSTRUCTION = "Your previous reply was cut off by the output limit. Continue exactly where it stopped. Do not repeat, restate or summarize anything you already wrote.";

type Part = LanguageModelV3StreamPart;
type Continue = (params: LanguageModelV3CallOptions) => PromiseLike<{ stream: ReadableStream<Part> }>;

/** Continuations already chained in a prompt, counted from its trailing instructions. */
export function continuationDepth(prompt: LanguageModelV3Prompt) {
  return prompt.filter(message => message.role === "user" && message.content.some(part => part.type === "text" && part.text === CONTINUE_INSTRUCTION)).length;
}

function addUsage(first: LanguageModelV3Usage, next: LanguageModelV3Usage): LanguageModelV3Usage {
  const sum = (a: number | undefined, b: number | undefined) => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  // Input stays the first request's: it is what this step's context held, and
  // context calibration compares it with that prompt. Every attempt, the
  // continuations' re-sent input included, is recorded on its own for billing.
  return { inputTokens: first.inputTokens, outputTokens: {
    total: sum(first.outputTokens.total, next.outputTokens.total),
    text: sum(first.outputTokens.text, next.outputTokens.text),
    reasoning: sum(first.outputTokens.reasoning, next.outputTokens.reasoning),
  } };
}

/**
 * When a text answer stops at the output limit, ask the same model to continue
 * and splice the continuation into the same text part, so callers see one
 * complete answer with the final finish reason. A step that started a tool call
 * is never continued: its input would be cut mid-argument and cannot be resumed,
 * so it keeps its `length` finish and is reported as incomplete.
 */
export function continueTruncated(stream: ReadableStream<Part>, params: LanguageModelV3CallOptions, next: Continue): ReadableStream<Part> {
  let reader = stream.getReader();
  let text = "", textId: string | null = null, heldEnd: Extract<Part, { type: "text-end" }> | null = null;
  let sawTool = false, splicing = false, first: Extract<Part, { type: "finish" }> | null = null;
  // The open text part the continuation's text joins; null once that part was
  // closed, when the continuation's text becomes a part of its own.
  let mergeId: string | null = null;
  const suffix = `-continued-${continuationDepth(params.prompt) + 1}`;
  const flush = (controller: ReadableStreamDefaultController<Part>) => { if (heldEnd) { controller.enqueue(heldEnd); heldEnd = null; } };
  const continuable = (part: Extract<Part, { type: "finish" }>) => part.finishReason.unified === "length" && !sawTool && text.length > 0
    && continuationDepth(params.prompt) < MAX_CONTINUATIONS && !params.abortSignal?.aborted;
  return new ReadableStream<Part>({
    async pull(controller) {
      for (;;) {
        const item = await reader.read();
        if (item.done) { flush(controller); controller.close(); return; }
        const part = item.value;
        if (splicing) {
          // The continuation's own framing is already sent; its text joins the held part.
          if (part.type === "stream-start" || part.type === "response-metadata") continue;
          if (part.type === "text-start") { if (!mergeId) controller.enqueue({ ...part, id: part.id + suffix }); continue; }
          if (part.type === "text-delta") { controller.enqueue({ ...part, id: mergeId ?? part.id + suffix }); return; }
          if (part.type === "text-end") {
            if (mergeId) heldEnd = { ...part, id: mergeId }; else controller.enqueue({ ...part, id: part.id + suffix });
            continue;
          }
          // Reasoning may precede the continued text; the held text part stays open.
          if (part.type === "reasoning-start" || part.type === "reasoning-delta" || part.type === "reasoning-end") { controller.enqueue({ ...part, id: part.id + suffix }); return; }
          if (part.type === "finish") { flush(controller); controller.enqueue({ ...part, usage: addUsage(first!.usage, part.usage) }); continue; }
        }
        if (part.type === "text-start") { flush(controller); textId = part.id; controller.enqueue(part); return; }
        if (part.type === "text-delta") { text += part.delta; controller.enqueue(part); return; }
        if (part.type === "text-end") { flush(controller); heldEnd = part; continue; }
        if (part.type === "tool-input-start" || part.type === "tool-call") sawTool = true;
        if (part.type === "finish" && !splicing && continuable(part)) {
          first = part; mergeId = heldEnd ? textId : null;
          const prompt: LanguageModelV3Prompt = [...params.prompt,
            { role: "assistant", content: [{ type: "text", text }] },
            { role: "user", content: [{ type: "text", text: CONTINUE_INSTRUCTION }] }];
          const continued = await next({ ...params, prompt });
          reader.releaseLock();
          reader = continued.stream.getReader();
          splicing = true;
          continue;
        }
        flush(controller); controller.enqueue(part); return;
      }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
}
