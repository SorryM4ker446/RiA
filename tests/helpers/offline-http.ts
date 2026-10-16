import { fetch as undiciFetch, MockAgent, setGlobalDispatcher } from "undici";

// Loaded only by the isolated test server, never by application code or builds.
if (process.env.APP_RUNTIME !== "test" || !process.send) {
  throw new Error("Offline HTTP fixtures require an isolated test child process");
}
const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);
// Use matching fetch/dispatcher versions and bridge native Request/Response.
// Node's bundled Undici need not share the installed package's global symbol.
globalThis.fetch = async (input, options) => {
  const request = new Request(input, options);
  const response = await undiciFetch(request.url, {
    method: request.method, headers: Object.fromEntries(request.headers), signal: request.signal,
    ...(!["GET", "HEAD"].includes(request.method) ? { body: await request.text() } : {}),
    dispatcher: agent,
  });
  // Undici's ReadableStream type is distinct from the DOM one native Response
  // expects; the runtime object is a web stream either way.
  return new Response(response.body as unknown as BodyInit, { status: response.status, headers: Object.fromEntries(response.headers) });
};

if (process.env.PRIVATE_AI_HTTP_FIXTURE === "1") {
  const provider = agent.get("https://openrouter.ai");
  const catalogRow = (id, name, input, output, extra = {}) => ({
    id, name, description: `Offline fixture for ${id}`, context_length: 200000,
    architecture: { input_modalities: input, output_modalities: output },
    supported_parameters: ["tools", ...(input.includes("image") ? ["image"] : [])],
    pricing: { prompt: "0.000001", completion: "0.000002" }, ...extra,
  });
  provider.intercept({ path: "/api/v1/models?output_modalities=text", method: "GET" }).reply(200, {
    data: [
      catalogRow("anthropic/claude-opus-4.6", "Claude Opus Offline", ["text", "image"], ["text"]),
      catalogRow("google/gemini-3-flash-preview", "Gemini Flash Offline", ["text", "image"], ["text"]),
      // Two rows the normalizer must skip: one that repeats an id already
      // seen, one whose id is not a usable `author/name`. A live feed carries
      // these routinely, and they must not cost the page the rest of the
      // catalog — the page lists what parsed and notes what it dropped.
      catalogRow("google/gemini-3-flash-preview", "Gemini Flash Offline duplicate", ["text"], ["text"]),
      { id: "not-a-namespaced-id", name: "Broken Row" },
    ],
  }, { headers: { "content-type": "application/json" } }).persist();
  provider.intercept({ path: "/api/v1/images/models", method: "GET" }).reply(200, {
    data: [catalogRow("google/gemini-3.1-flash-image-preview", "Gemini Image Offline", ["text", "image"], ["image"])],
  }, { headers: { "content-type": "application/json" } }).persist();
  provider.intercept({ path: "/api/v1/images/models/google/gemini-3.1-flash-image-preview/endpoints", method: "GET" }).reply(200, {
    endpoints: [{ supported_parameters: { input_references: { min: 0, max: 1 } } }],
  }, { headers: { "content-type": "application/json" } }).persist();
  provider.intercept({ path: "/api/v1/videos/models", method: "GET" }).reply(200, {
    data: [catalogRow("bytedance/seedance-2.0", "Seedance Offline", ["text"], ["video"], { supported_parameters: [], supported_frame_images: ["first_frame"], pricing_skus: { "per-video-second": "0.08" } })],
  }, { headers: { "content-type": "application/json" } }).persist();
  provider.intercept({ path: "/api/v1/embeddings/models", method: "GET" }).reply(200, {
    data: [catalogRow("openai/text-embedding-3-small", "Embedding Offline", ["text"], ["embeddings"])],
  }, { headers: { "content-type": "application/json" } }).persist();
  provider.intercept({ path: "/api/v1/chat/completions", method: "POST", body: raw => {
    const body = JSON.parse(String(raw));
    return body.model === "anthropic/claude-opus-4.6" && JSON.stringify(body.messages).includes("OFFLINE_PRIMARY_FAILURE");
  } }).reply(503, options => {
    const body = JSON.parse(String(options.body));
    process.send({ type: "provider-call", stream: body.stream === true, messages: body.messages });
    return JSON.stringify({ error: { message: "Synthetic primary unavailable", code: 503 } });
  }, { headers: { "content-type": "application/json" } }).persist();
  for (const stream of [false, true]) {
    provider.intercept({ path: "/api/v1/chat/completions", method: "POST", body: (body) => (JSON.parse(String(body)).stream === true) === stream }).reply(200, (options) => {
      const body = JSON.parse(String(options.body));
      // Record synthetic prompts over IPC, never headers, credentials or disk logs.
      process.send({ type: "provider-call", stream: body.stream === true, messages: body.messages });
      const latest = body.messages.findLast((message) => message.role === "user");
      const prompt = typeof latest?.content === "string" ? latest.content
        : (latest?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
      let content = `离线回答：${prompt}`;
      // Controlled grounded response for the real streaming/citation workflow.
      // It exercises evidence transport, never measures a live model's reasoning.
      if (prompt === "出门办事的钱怎样领回来") {
        const system = body.messages.filter(message => message.role === "system").map(message => typeof message.content === "string"
          ? message.content : message.content.filter(part => part.type === "text").map(part => part.text).join("\n")).join("\n");
        const line = system.split("\n").find(value => value.startsWith('[{"reference":'));
        const evidence = line ? JSON.parse(line) : [];
        const main = evidence.find(source => source.excerpt.includes("十个工作日"));
        const exception = evidence.find(source => source.excerpt.includes("书面说明"));
        content = main && exception
          ? `保留税务票据，在回程后的十个工作日内提交费用核销申请。[差旅规程](${main.url})\n\n逾期需要主管提供书面说明。[例外条款](${exception.url})`
          : "现有知识库证据不足，无法确认申领规则。";
      }
      const systemText = body.messages.filter(message => message.role === "system").map(message => typeof message.content === "string" ? message.content
        : message.content.filter(part => part.type === "text").map(part => part.text).join("\n")).join("\n");
      if (prompt === "木星表面温度" && systemText.startsWith("Answer using the provided knowledge evidence.")) content = "知识库没有该信息，现有证据不足，无法确定木星表面温度。";
      if (!body.stream && systemText.startsWith("You assess knowledge-grounded answers.")) {
        const evaluation = JSON.parse(prompt);
        // This is a deterministic UI fixture, not a semantic-quality oracle.
        content = JSON.stringify({ checks: evaluation.criteria.map(criterion => ({
          id: criterion.id, verdict: !evaluation.answerable && criterion.id !== "answerability" ? "not-applicable" : "pass",
          reason: "离线界面测试评审结果，不代表真实模型质量。", answerQuote: evaluation.answer.slice(0, 100),
          evidence: evaluation.sources.length ? [{ chunkId: evaluation.sources[0].chunkId, quote: evaluation.sources[0].excerpt.slice(0, 100) }] : [],
        })) });
        if (evaluation.criteria.some(criterion => criterion.statement === "OFFLINE_REVIEW_INVALID_JSON")) content = "Synthetic malformed judge response";
      }
      const base = { id: "offline-completion", model: body.model, usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
      if (body.modalities?.includes("image")) return JSON.stringify({ ...base, choices: [{ index: 0, message: { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII=" } }] }, finish_reason: "stop" }] });
      if (body.stream) {
        const taskRequested = prompt.includes("OFFLINE_CREATE_TASK");
        const knowledgeRequested = prompt.includes("OFFLINE_SEARCH_KNOWLEDGE");
        if ((taskRequested || knowledgeRequested) && !body.messages.some(message => message.role === "tool") && body.tools?.length) {
          const name = taskRequested ? "createTask" : "searchKnowledge";
          const args = taskRequested ? { title: "浏览器真实任务" } : { query: "发布回滚窗口", topK: 4 };
          const chunks = [
            { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_browser_fixture", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
            { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          ];
          return chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
        }
        const chunks = [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: content.slice(0, 5) }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: { content: content.slice(5) }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
      }
      return JSON.stringify({ ...base, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] });
    }, { headers: { "content-type": stream ? "text/event-stream" : "application/json" } }).persist();
  }
  provider.intercept({ path: "/api/v1/embeddings", method: "POST" }).reply(200, (options) => {
    const body = JSON.parse(String(options.body));
    const values = Array.isArray(body.input) ? body.input : [body.input];
    const vector = (text: string) => /公务出行|费用核销|出门办事|差旅/u.test(text) ? [1, 0, 0]
      : /医疗|医院/u.test(text) ? [0, 1, 0] : [0, 0, 1];
    return JSON.stringify({ object: "list", model: body.model, data: values.map((text, index) => ({ object: "embedding", index, embedding: vector(text) })), usage: { prompt_tokens: values.length, total_tokens: values.length } });
  }, { headers: { "content-type": "application/json" } }).persist();
  provider.intercept({ path: "/api/v1/videos", method: "POST" }).reply(200, options => {
    const body = JSON.parse(String(options.body));
    process.send({ type: "provider-call", stream: false, messages: [{ role: "user", content: body.prompt }] });
    return JSON.stringify({ id: "offline-video", polling_url: "https://openrouter.ai/api/v1/videos/offline-video", status: "queued" });
  }, { headers: { "content-type": "application/json" } }).persist();
  provider.intercept({ path: "/api/v1/videos/offline-video", method: "GET" }).reply(200, { id: "offline-video", polling_url: "https://openrouter.ai/api/v1/videos/offline-video", status: "completed", unsigned_urls: ["https://media.example.invalid/offline.mp4"] }, { headers: { "content-type": "application/json" } }).persist();
  agent.get("https://media.example.invalid").intercept({ path: "/offline.mp4", method: "GET" }).reply(200, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]), { headers: { "content-type": "video/mp4" } }).persist();
}
