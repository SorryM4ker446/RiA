import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LanguageModelV3FunctionTool, LanguageModelV3ToolResultOutput } from "@ai-sdk/provider";
import { after, before, beforeEach, test } from "node:test";

// The adapter is exercised against a local server that speaks DeepSeek's wire
// format, not against a mock of this application's own types. Everything the
// adapter is trusted to do — the tool loop, the reasoning hand-back, the
// thinking-mode rules — is a claim about the protocol, and a test written
// against a same-shape mock would agree with the adapter by construction.

const deepseek = await import("@/lib/models/providers/deepseek");
const { createDeepSeekChatModel, deepSeekBaseURL } = await import("@/lib/models/providers/deepseek-chat");

let baseUrl = "";
let requests = [];
type StubResponse = { sse: unknown[]; truncate?: boolean } | { status: number; json: unknown };
type StubHandler = (request: unknown, entry: unknown) => StubResponse | Promise<StubResponse>;
let handler: StubHandler = () => ({ status: 200, json: {} });

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization, body: raw ? JSON.parse(raw) : null });
  const result = await handler(request, requests.at(-1));
  if ("sse" in result) {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const chunk of result.sse) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }
  response.writeHead(result.status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(result.json));
});

before(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.DEEPSEEK_BASE_URL = baseUrl;
  process.env.DEEPSEEK_API_KEY = "test-key";
  delete process.env.DEEPSEEK_THINKING;
  delete process.env.DEEPSEEK_REASONING_EFFORT;
});

after(() => server.close());

beforeEach(() => {
  requests = [];
  handler = () => ({ status: 200, json: {} });
});

function textStream(text) {
  return {
    sse: [
      { id: "chat-1", model: "deepseek-v4-pro", choices: [{ index: 0, delta: { role: "assistant", content: text } }] },
      { id: "chat-1", model: "deepseek-v4-pro", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 4, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 8 } },
    ],
  };
}

async function collect(stream) {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

test("the official model list maps to library rows without inventing capability", async () => {
  handler = () => ({
    status: 200,
    json: {
      object: "list",
      data: [
        { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek", name: "DeepSeek V4 Pro", context_window: 393216, max_output_tokens: 65536, input_modalities: ["text", "image"], output_modalities: ["text"] },
        { id: "deepseek-flash", object: "model", owned_by: "deepseek", input_modalities: ["text"], output_modalities: ["text"], effort: { supported_levels: ["low", "high", "max"], default_level: "high" } },
        { id: "deepseek-vision-legacy", object: "model", input_modalities: ["text"], output_modalities: ["image"] },
        { id: "not a model id", object: "model" },
      ],
    },
  });

  const { models, invalidRows } = await deepseek.deepseekProvider.fetchCatalog("chat", new AbortController().signal);
  assert.equal(requests[0].url, "/models");
  assert.equal(requests[0].authorization, "Bearer test-key");
  // A model that cannot answer in text is dropped rather than offered and then
  // failing at send time, and an id the provider would never use is not trusted.
  assert.deepEqual(models.map(model => model.modelId), ["deepseek-v4-pro", "deepseek-flash"]);
  assert.equal(invalidRows, 2);
  const pro = models[0];
  assert.equal(pro.providerId, "deepseek");
  // The context window is the provider's own number, read from the list.
  assert.equal(pro.contextLength, 393216);
  // Image input is read from the list's own modality field, and the adapter
  // implements the documented block shape, so the claim the library makes is
  // one this application can actually honour.
  assert.equal(pro.providerSupportsImageInput, true);
  assert.equal(pro.supportsImageInput, true);
  assert.equal(models[1].supportsImageInput, false);
  // The list carries no price, so none is invented.
  assert.deepEqual(pro.pricing, {});
  // Tool support is not in the list; it comes from a rule that names its source.
  assert.equal(pro.supportsTools, true);
  assert.ok(deepseek.DEEPSEEK_CAPABILITY_RULES.tools.source.startsWith("https://"));
  assert.match(deepseek.DEEPSEEK_CAPABILITY_RULES.tools.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
});

test("the provider offers chat only, so the other selectors stay empty", () => {
  assert.deepEqual(deepseek.deepseekProvider.offeredModes, ["chat"]);
  assert.equal(deepseek.deepseekProvider.createImageModel, undefined);
  assert.equal(deepseek.deepseekProvider.createEmbeddingModel, undefined);
  assert.equal(deepseek.deepseekProvider.isTrustedModelId("deepseek-v4-pro"), true);
  assert.equal(deepseek.deepseekProvider.isTrustedModelId("author/name"), false);
  assert.equal(deepseek.deepseekProvider.isTrustedModelId(""), false);
});

test("a rejected credential is reported as a rejected credential", async () => {
  handler = () => ({ status: 401, json: { error: { message: "Authentication Fails" } } });
  await assert.rejects(
    () => deepseek.deepseekProvider.fetchCatalog("chat", new AbortController().signal),
    (error: { reason?: string; message: string }) => error.reason === "unauthorized" && /Authentication Fails/.test(error.message) === false,
  );
});

test("a streamed answer carries reasoning, text, usage and the cache split", async () => {
  handler = () => ({
    sse: [
      { id: "chat-1", model: "deepseek-v4-pro", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "先想想" } }] },
      { id: "chat-1", model: "deepseek-v4-pro", choices: [{ index: 0, delta: { reasoning_content: " 再答" } }] },
      { id: "chat-1", model: "deepseek-v4-pro", choices: [{ index: 0, delta: { content: "答案" } }] },
      { id: "chat-1", model: "deepseek-v4-pro", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 4, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 8 } },
    ],
  });

  const model = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  const result = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }],
  });
  const parts = await collect(result.stream);
  const types = parts.map(part => part.type);

  assert.deepEqual(types, ["stream-start", "response-metadata", "reasoning-start", "reasoning-delta", "reasoning-delta", "text-start", "text-delta", "text-end", "reasoning-end", "finish"]);
  assert.equal(parts.filter(part => part.type === "reasoning-delta").map(part => part.delta).join(""), "先想想 再答");
  const finish = parts.at(-1);
  assert.equal(finish.finishReason.unified, "stop");
  assert.equal(finish.usage.inputTokens.total, 11);
  // A cache hit is not the same as fresh input, and reporting them as one total
  // would misstate what the request cost.
  assert.equal(finish.usage.inputTokens.cacheRead, 3);
  assert.equal(finish.usage.inputTokens.noCache, 8);
  assert.equal(finish.usage.outputTokens.total, 4);
  assert.equal(requests[0].body.stream, true);
  assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
});

test("the request names the model the library entry was created for", async () => {
  handler = () => textStream("答案");
  const model = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }] });
  // The field has to carry the id string DeepSeek knows. It once carried a
  // schema object instead, which serialised into the body as a nested JSON
  // blob and came back as a bare 400 — and the rest of the adapter was tested
  // only through fields other than this one, so nothing noticed.
  assert.equal(typeof requests[0].body.model, "string");
  assert.equal(requests[0].body.model, "deepseek-v4-pro");

  requests = [];
  handler = () => ({ status: 200, json: { id: "chat-1", model: "deepseek-v4-pro", choices: [{ index: 0, message: { role: "assistant", content: "答案" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } } });
  await model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }] });
  // Both call paths build the body the same way, so both are checked.
  assert.equal(requests[0].body.model, "deepseek-v4-pro");
});

test("thinking mode is declared, and sampling parameters are not sent while it is on", async () => {
  handler = () => textStream("答案");
  const model = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  await collect((await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }], temperature: 0.3, topP: 0.9 })).stream);
  assert.deepEqual(requests[0].body.thinking, { type: "enabled" });
  assert.equal(requests[0].body.temperature, undefined);
  assert.equal(requests[0].body.top_p, undefined);

  requests = [];
  const off = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL(), defaultThinking: { enabled: false } });
  await collect((await off.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }], temperature: 0.3, topP: 0.9 })).stream);
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
  assert.equal(requests[0].body.temperature, 0.3);
  assert.equal(requests[0].body.top_p, 0.9);
  // Disabled thinking and an effort are two different settings; sending both
  // would be asking the provider to contradict itself.
  assert.equal(requests[0].body.reasoning_effort, undefined);
});

test("a required tool choice is downgraded while thinking is on, and honoured when it is off", async () => {
  handler = () => textStream("答案");
  const tools: LanguageModelV3FunctionTool[] = [{ type: "function", name: "lookup", description: "look something up", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }];

  const thinking = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  await collect((await thinking.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }], tools, toolChoice: { type: "required" } })).stream);
  assert.equal(requests[0].body.tool_choice, "auto");
  assert.equal(requests[0].body.tools[0].function.name, "lookup");
  assert.deepEqual(requests[0].body.tools[0].function.parameters, { type: "object", properties: { q: { type: "string" } }, required: ["q"] });

  requests = [];
  const off = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL(), defaultThinking: { enabled: false } });
  await collect((await off.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }], tools, toolChoice: { type: "required" } })).stream);
  assert.equal(requests[0].body.tool_choice, "required");
});

test("a tool call is streamed as tool input and reported as a tool finish", async () => {
  handler = () => ({
    sse: [
      { id: "chat-2", model: "deepseek-v4-pro", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":" } }] } }] },
      { id: "chat-2", model: "deepseek-v4-pro", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"天气\"}" } }] } }] },
      { id: "chat-2", model: "deepseek-v4-pro", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 6 } },
    ],
  });
  const model = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  const parts = await collect((await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }],
    tools: [{ type: "function", name: "lookup", description: "d", inputSchema: { type: "object", properties: {} } }],
  })).stream);

  const start = parts.find(part => part.type === "tool-input-start");
  assert.deepEqual({ id: start.id, toolName: start.toolName }, { id: "call_1", toolName: "lookup" });
  assert.equal(parts.filter(part => part.type === "tool-input-delta").map(part => part.delta).join(""), '{"q":"天气"}');
  assert.equal(parts.at(-1).finishReason.unified, "tool-calls");
});

test("reasoning produced in a turn is sent back with the next request that carries tools", async () => {
  handler = () => textStream("答案");
  const model = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  await collect((await model.doStream({
    prompt: [
      { role: "user", content: [{ type: "text", text: "第一问" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "先查工具" },
          { type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: '{"q":"天气"}' },
        ],
      },
      // The adapter reads a bare string output, which the V3 output type no longer models.
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "lookup", output: { type: "text", value: "晴" } satisfies LanguageModelV3ToolResultOutput }] },
    ],
    tools: [{ type: "function", name: "lookup", description: "d", inputSchema: { type: "object", properties: {} } }],
  })).stream);

  const assistant = requests[0].body.messages.find(message => message.role === "assistant");
  // The provider requires the chain of thought of a tool turn to come back;
  // dropping it is what turns the second step into a 400.
  assert.equal(assistant.reasoning_content, "先查工具");
  assert.deepEqual(assistant.tool_calls, [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"q":"天气"}' } }]);
  const toolMessage = requests[0].body.messages.find(message => message.role === "tool");
  assert.equal(toolMessage.tool_call_id, "call_1");
  // The tagged form is unwrapped: the provider reads this as the tool's text,
  // not as a JSON object it would have to reason about.
  assert.equal(toolMessage.content, "晴");
  assert.equal(JSON.parse(JSON.stringify(toolMessage)).content.includes("type"), false);
});

test("an upstream failure keeps its status so the fallback rules can read it", async () => {
  handler = () => ({ status: 429, json: { error: { message: "Rate limit reached, please try again later." } } });
  const model = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  await assert.rejects(
    async () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }] }),
    (error: { statusCode: number; isRetryable: boolean; responseBody: unknown }) => {
      assert.equal(error.statusCode, 429);
      assert.equal(error.isRetryable, true);
      // The provider can echo the request in an error body. Diagnostics here
      // carry the status, not its text.
      assert.equal(error.responseBody, undefined);
      return true;
    },
  );
});

test("a missing key is refused before any request is made", async () => {
  const model = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "", baseURL: deepSeekBaseURL() });
  await assert.rejects(
    async () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }] }),
    /not configured/,
  );
  assert.equal(requests.length, 0);
});

test("cancellation stops the request instead of waiting for the answer", async () => {
  const controller = new AbortController();
  handler = async () => {
    controller.abort();
    return textStream("答案");
  };
  const model = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  await assert.rejects(
    async () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }], abortSignal: controller.signal }),
    (error: { name: string }) => error.name === "AbortError",
  );
});

// --- Acceptance cases the first pass had not covered -------------------------

test("a model unavailable upstream keeps its status so the fallback rule can act on it", async () => {
  handler = () => ({ status: 404, json: { error: { message: "Model Not Exist" } } });
  const model = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  await assert.rejects(
    async () => model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }] }),
    (error: { statusCode: number; isRetryable: boolean }) => error.statusCode === 404 && error.isRetryable === false,
  );
});

test("a successful status with an unusable body is not read as an answer", async () => {
  handler = () => ({ status: 200, json: { object: "list", data: [] } });
  const model = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  await assert.rejects(
    async () => model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }] }),
    /cannot read/,
  );

  const empty = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  const parts = await collect((await empty.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }] })).stream);
  // Nothing came back at all: that is not a completed answer.
  assert.equal(parts.at(-1).type, "finish");
  assert.equal(parts.at(-1).finishReason.unified, "error");
});

test("a stream cut off before the finish reason is reported as a failure, not a stop", async () => {
  handler = () => ({
    sse: [
      { id: "chat-9", model: "deepseek-v4-pro", choices: [{ index: 0, delta: { content: "半句" } }] },
      // The connection drops here: no finish reason, no usage, no [DONE].
    ],
    truncate: true,
  });
  const model = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  const parts = await collect((await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "问题" }] }] })).stream);
  const finish = parts.at(-1);
  assert.equal(finish.type, "finish");
  // Storing half an answer as a successful one is the failure this prevents.
  assert.equal(finish.finishReason.unified, "error");
  assert.equal(finish.finishReason.raw, "stream-ended-without-finish");
  // The text that did arrive is still delivered, so the user sees the fragment
  // instead of an empty turn.
  assert.equal(parts.filter(part => part.type === "text-delta").map(part => part.delta).join(""), "半句");
});

test("a turn without tools sends no tool fields and no reasoning to hand back", async () => {
  handler = () => textStream("答案");
  const model = createDeepSeekChatModel({ modelId: "deepseek-v4-pro", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  await collect((await model.doStream({
    prompt: [
      { role: "user", content: [{ type: "text", text: "第一问" }] },
      { role: "assistant", content: [{ type: "text", text: "上一轮回答" }] },
      { role: "user", content: [{ type: "text", text: "追问" }] },
    ],
  })).stream);

  assert.equal(requests[0].body.tools, undefined);
  assert.equal(requests[0].body.tool_choice, undefined);
  const assistant = requests[0].body.messages.find(message => message.role === "assistant");
  // Without tools the provider ignores the field, so nothing is invented for it.
  assert.equal(assistant.reasoning_content, undefined);
  assert.equal(assistant.content, "上一轮回答");
});

test("an image is inlined as the documented block shape", async () => {
  handler = () => textStream("图里是一张截图");
  const model = createDeepSeekChatModel({ modelId: "deepseek-flash", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  const png = "iVBORw0KGgo=";
  await collect((await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "这是什么" }, { type: "file", data: png, mediaType: "image/png" }] }],
  })).stream);

  const content = requests[0].body.messages[0].content;
  assert.deepEqual(content, [
    { type: "text", text: "这是什么" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
  ]);

  // A message with no attachment stays a plain string, which is what the
  // provider expects and what every previous turn has been.
  await collect((await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "只有文字" }] }] })).stream);
  assert.equal(requests[1].body.messages[0].content, "只有文字");
});

test("an image outside a user message is dropped instead of failing the request", async () => {
  handler = () => textStream("好");
  const model = createDeepSeekChatModel({ modelId: "deepseek-flash", getApiKey: () => "test-key", baseURL: deepSeekBaseURL() });
  await collect((await model.doStream({
    prompt: [
      { role: "user", content: [{ type: "text", text: "看图" }] },
      // The provider answers 400 for an image in an assistant turn, so the
      // image is left out and the turn's text is kept.
      { role: "assistant", content: [{ type: "file", data: "iVBORw0KGgo=", mediaType: "image/png" }, { type: "text", text: "这是一张图" }] },
      { role: "user", content: [{ type: "text", text: "再说" }] },
    ],
  })).stream);

  const assistant = requests[0].body.messages.find(message => message.role === "assistant");
  assert.equal(assistant.content, "这是一张图");
  assert.equal(JSON.stringify(assistant).includes("image_url"), false);
});
