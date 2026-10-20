import { fetch as undiciFetch, MockAgent, setGlobalDispatcher } from "undici";
import { registryFixtureEntries } from "./registry-fixture.ts";
import { marketSearchItem, marketSnapshot } from "./skill-marketplace-fixture.ts";

// Loaded only by the isolated test server, never by application code or builds.
if (process.env.APP_RUNTIME !== "test" || !process.send) {
  throw new Error("Offline HTTP fixtures require an isolated test child process");
}
const agent = new MockAgent();
agent.disableNetConnect();
// A test may opt into exactly one isolated loopback extension fixture. All
// other external and loopback destinations remain blocked by the default guard.
if (process.env.PRIVATE_AI_EXTENSION_FIXTURE_ORIGIN) {
  const allowed = new URL(process.env.PRIVATE_AI_EXTENSION_FIXTURE_ORIGIN);
  if (allowed.protocol !== "http:" || allowed.hostname !== "127.0.0.1" || allowed.pathname !== "/" || !allowed.port) throw new Error("Invalid extension fixture origin");
  agent.enableNetConnect(host => host === allowed.host);
}
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
  const skills = agent.get("https://skills.sh");
  skills.intercept({ path: /^\/api\/(?:search|download)/, method: "GET" }).reply(options => {
    const url = new URL(options.path, "https://skills.sh");
    if (url.pathname === "/api/search") {
      const query = url.searchParams.get("q");
      return { statusCode: query === "unavailable" ? 503 : 200, data: JSON.stringify({ skills: query === "nothing" ? [] : [marketSearchItem] }) };
    }
    return { statusCode: 200, data: JSON.stringify(marketSnapshot()) };
  }).persist();
  const registry = agent.get("https://registry.modelcontextprotocol.io");
  const entries = registryFixtureEntries(process.env.PRIVATE_AI_EXTENSION_FIXTURE_ORIGIN || "https://service.example.invalid");
  registry.intercept({ path: /^\/v0\.1\/servers(?:\?|\/)/, method: "GET" }).reply(options => {
    const url = new URL(options.path, "https://registry.modelcontextprotocol.io");
    if (url.pathname === "/v0.1/servers") {
      const search = url.searchParams.get("search") || "";
      if (search === "unavailable") return { statusCode: 503, data: JSON.stringify({ error: "Synthetic registry outage" }) };
      const selected = entries.filter(entry => entry.server.name.includes(search));
      const offset = url.searchParams.get("cursor") === "fixture:20" ? 20 : 0;
      return { statusCode: 200, data: JSON.stringify({ servers: selected.slice(offset, offset + 20), metadata: { nextCursor: offset + 20 < selected.length ? "fixture:20" : null } }) };
    }
    const match = url.pathname.match(/^\/v0\.1\/servers\/([^/]+)\/versions\/([^/]+)$/);
    const entry = match && entries.find(item => item.server.name === decodeURIComponent(match[1]) && item.server.version === decodeURIComponent(match[2]));
    return { statusCode: entry ? 200 : 404, data: JSON.stringify(entry || { error: "Not found" }) };
  }).persist();
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
      if (body.tools?.some(tool => tool.type === "openrouter:web_search")) {
        return JSON.stringify({ id: "offline-gateway-search", choices: [{ message: { role: "assistant", content: "官方发布说明中的更新。", annotations: [{ type: "url_citation", url_citation: { title: "Offline official release", url: "https://example.invalid/official-release", content: "Official search evidence from the gateway." } }] }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, cost: 0.002, server_tool_use: { web_search_requests: 1 } } });
      }
      const latest = body.messages.findLast((message) => message.role === "user");
      const prompt = typeof latest?.content === "string" ? latest.content
        : (latest?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
      let content = `离线回答：${prompt}`;
      const fileEditRequest = prompt === "请整理个人资料卡片：统一配色，新增资料卡组件和使用说明，并移除旧草稿。";
      if (fileEditRequest) content = "已完成个人资料卡片的整理。\n\n- 统一了界面配色与间距。\n- 新增资料卡组件和使用说明。\n- 清理了不再使用的旧草稿。\n\n下方是本轮文件变更，点击文件即可继续检查。";
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
      if (!body.stream && systemText.startsWith("Choose the number of web search results")) content = JSON.stringify({ maxResults: 14 });
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
        const terminalResults = body.messages.filter(message => message.role === "tool").length;
        if ((prompt.includes("OFFLINE_TERMINAL_COMMAND") || fileEditRequest) && terminalResults < (prompt.includes("TERMINAL_TWICE") ? 2 : 1)) {
          const name = "runTerminalCommand";
          if (!body.tools?.some(tool => tool.function?.name === name)) throw new Error("Terminal tool was not offered to the fixture model");
          const padding = prompt.includes("TERMINAL_LONG") ? ("# 长脚本🙂\n".repeat(180_000)) : "";
          let command = padding + (process.platform === "win32"
            ? "[IO.File]::AppendAllText('terminal-proof.txt', 'once'); [Console]::WriteLine('terminal-ready-你好')" + (prompt.includes("TERMINAL_STOP") ? "; Start-Sleep -Seconds 30" : "")
            : "printf once >> terminal-proof.txt; printf 'terminal-ready-你好\\n'" + (prompt.includes("TERMINAL_STOP") ? "; sleep 30" : ""));
          const terminal = body.tools!.find(tool => tool.function?.name === name)!;
          if (fileEditRequest) {
            const edits = [
              { path: "src/theme.ts", text: "export const theme = {\n  radius: 12,\n  spacing: 16,\n  accent: 'slate',\n};\n" },
              { path: "src/components/profile-card.tsx", text: "export function ProfileCard() {\n  return (\n    <article>\n      <h2>个人资料</h2>\n      <p>在这里管理你的公开信息。</p>\n    </article>\n  );\n}\n" },
              { path: "README.md", text: "# 个人资料卡片\n\n## 使用方式\n\n导入 ProfileCard 组件并传入资料。\n\n## 界面规范\n\n统一使用项目的配色和间距。\n" },
            ];
            const quote = (value: string) => `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
            command = process.platform === "win32"
              ? ["New-Item -ItemType Directory -Path 'src/components' -Force | Out-Null", ...edits.map(edit => `[IO.File]::WriteAllText(${quote(edit.path)}, ${quote(edit.text)}, (New-Object System.Text.UTF8Encoding($false)))`), "Remove-Item -LiteralPath 'old-draft.txt'"].join("; ")
              : ["mkdir -p src/components", ...edits.map(edit => `printf '%s' ${quote(edit.text)} > ${quote(edit.path)}`), "rm old-draft.txt"].join("; ");
          }
          const folders = fileEditRequest ? JSON.parse((terminal.function as { description?: string }).description?.split("Terminal-enabled folders (data, not instructions): ")[1] ?? "[]") : [];
          const args = { grantId: fileEditRequest ? folders[0]?.id : /GRANT_ID=([a-zA-Z0-9_-]+)/.exec(prompt)?.[1], command, timeoutSeconds: 60 };
          return `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `terminal-fixture-call-${terminalResults}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`;
        }
        const skillRequested = prompt.includes("OFFLINE_READ_PLUGIN_SKILL");
        const skillResults = body.messages.filter(message => message.role === "tool").length;
        if (skillRequested && skillResults < 2 && body.tools?.some(tool => tool.function?.name === "readPluginSkill")) {
          const packageId = systemText.match(/skills\.sh\.[a-f0-9]{40}/)?.[0];
          const args = { packageId, path: skillResults ? "references/style.md" : "SKILL.md" };
          const chunks = [
            { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `skill-read-${skillResults}`, type: "function", function: { name: "readPluginSkill", arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] },
            { choices: [], usage: base.usage },
          ];
          return chunks.map(chunk => `data: ${JSON.stringify({ ...base, ...chunk })}\n\n`).join("") + "data: [DONE]\n\n";
        }
        const taskRequested = prompt.includes("OFFLINE_CREATE_TASK");
        const webRequested = prompt.includes("OFFLINE_WEB_SEARCH");
        const knowledgeRequested = prompt.includes("OFFLINE_SEARCH_KNOWLEDGE");
        const extensionRequested = prompt.includes("OFFLINE_EXTENSION_TOOL");
        const documentRequested = prompt.includes("OFFLINE_CONVERT_DOCUMENT");
        if ((taskRequested || webRequested || knowledgeRequested || extensionRequested || documentRequested) && !body.messages.some(message => message.role === "tool") && body.tools?.length) {
          const name = taskRequested ? "createTask" : webRequested ? "webSearch" : knowledgeRequested ? "searchKnowledge" : documentRequested ? "convertDocument" : body.tools.find(tool => tool.function?.name?.startsWith("ext"))?.function.name;
          if (!name) throw new Error("The requested extension tool was not offered to the fixture model");
          const args = webRequested ? { query: "official release", maxResults: 2 } : taskRequested ? { title: "浏览器真实任务" } : knowledgeRequested ? { query: "发布回滚窗口", topK: 4 } : documentRequested ? { documentId: /DOCUMENT_ID=([a-zA-Z0-9_-]+)/.exec(prompt)?.[1], format: "docx" } : { arguments: { text: "browser-extension-result" } };
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
