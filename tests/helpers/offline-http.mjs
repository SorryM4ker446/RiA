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
  return new Response(response.body, { status: response.status, headers: Object.fromEntries(response.headers) });
};

if (process.env.PRIVATE_AI_HTTP_FIXTURE === "1") {
  const provider = agent.get("https://openrouter.ai");
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
      const content = `离线回答：${prompt}`;
      const base = { id: "offline-completion", model: body.model, usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
      if (body.modalities?.includes("image")) return JSON.stringify({ ...base, choices: [{ index: 0, message: { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8XcAAAAASUVORK5CYII=" } }] }, finish_reason: "stop" }] });
      if (body.stream) {
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
    return JSON.stringify({ data: values.map((_, index) => ({ index, embedding: [1, 0, 0] })), usage: { prompt_tokens: values.length, total_tokens: values.length } });
  }, { headers: { "content-type": "application/json" } }).persist();
  provider.intercept({ path: "/api/v1/videos", method: "POST" }).reply(200, options => {
    const body = JSON.parse(String(options.body));
    process.send({ type: "provider-call", stream: false, messages: [{ role: "user", content: body.prompt }] });
    return JSON.stringify({ id: "offline-video", polling_url: "https://openrouter.ai/api/v1/videos/offline-video", status: "queued" });
  }, { headers: { "content-type": "application/json" } }).persist();
  provider.intercept({ path: "/api/v1/videos/offline-video", method: "GET" }).reply(200, { id: "offline-video", polling_url: "https://openrouter.ai/api/v1/videos/offline-video", status: "completed", unsigned_urls: ["https://media.example.invalid/offline.mp4"] }, { headers: { "content-type": "application/json" } }).persist();
  agent.get("https://media.example.invalid").intercept({ path: "/offline.mp4", method: "GET" }).reply(200, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109]), { headers: { "content-type": "video/mp4" } }).persist();
}
