import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { needsCacheBreakpoints, withCacheBreakpoints } from "@/lib/models/prompt-cache";

const prompt: LanguageModelV3Prompt = [
  { role: "system", content: "Stable instructions" },
  { role: "user", content: [{ type: "text", text: "Earlier question" }] },
  { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
  { role: "user", content: [{ type: "text", text: "[Context for this request]" }, { type: "text", text: "Latest question" }] },
  { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "searchKnowledge", input: "{}" }] },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "searchKnowledge", output: { type: "text", value: "result" } }] },
];

test("only Anthropic models through OpenRouter receive cache breakpoints", () => {
  assert.equal(needsCacheBreakpoints({ providerId: "openrouter", modelId: "anthropic/claude-opus-4.6" }), true);
  assert.equal(needsCacheBreakpoints({ providerId: "openrouter", modelId: "openai/gpt-5" }), false);
  assert.equal(needsCacheBreakpoints({ providerId: "deepseek", modelId: "deepseek-chat" }), false);
});

test("breakpoints mark the system prompt, the end of the previous turn and the end of the request", () => {
  const marked = withCacheBreakpoints(prompt);
  assert.deepEqual(marked.flatMap((message, index) => message.providerOptions?.openrouter ? [index] : []), [0, 2, 5]);
  assert.deepEqual(prompt.map(message => message.providerOptions), prompt.map(() => undefined), "the input prompt is not modified");
  assert.deepEqual(withCacheBreakpoints([{ role: "user", content: [{ type: "text", text: "first" }] }]).map(message => Boolean(message.providerOptions)), [true]);
});

test("the OpenRouter provider sends the breakpoints as cache_control", async () => {
  let body: { messages: Array<{ role: string; content: unknown }> } | undefined;
  const provider = createOpenRouter({ apiKey: "test-key", fetch: async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  const result = await provider.chat("anthropic/claude-opus-4.6").doStream({ prompt: withCacheBreakpoints(prompt) });
  await result.stream.pipeTo(new WritableStream());
  const cached = (body?.messages ?? []).map(message => JSON.stringify(message).includes('"cache_control":{"type":"ephemeral"}'));
  assert.deepEqual(cached, [true, false, true, false, false, true]);
});
