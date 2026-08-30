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
}
