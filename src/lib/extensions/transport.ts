import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "@/lib/server/api-error";
import { EXTENSION_LIMITS, extensionToolsSchema, validateToolSchema, type ExtensionConfig, type ExtensionTool } from "./schema";

const forbiddenHeaders = /^(host|content-length|connection|transfer-encoding|accept|mcp-session-id|mcp-protocol-version)$/i;
export const localProcessConnectionsAllowed = () => ["desktop", "test"].includes(process.env.APP_RUNTIME ?? "");
export function connectionCredentials(config: ExtensionConfig, credentials: Record<string, string>) {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(credentials)) {
    const normalized = process.platform === "win32" || config.type !== "mcp-stdio" ? name.toLowerCase() : name;
    if (names.has(normalized)) throw new ApiError({ code: "VALIDATION_ERROR", message: "凭据名称不能重复（HTTP 请求头及 Windows 环境变量不区分大小写）。" });
    names.add(normalized);
    if (config.type === "mcp-stdio") {
      if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|RIA_.*|LOCAL_ACCESS_TOKEN|DESKTOP_.*|DATABASE_URL)$/i.test(name)) throw new ApiError({ code: "VALIDATION_ERROR", message: "该进程环境变量由应用保留。" });
    } else if (forbiddenHeaders.test(name) || /[\r\n]/.test(value)) {
      throw new ApiError({ code: "VALIDATION_ERROR", message: "凭据包含不支持的 HTTP 请求头。" });
    }
  }
  return credentials;
}

export async function validateProcessConfig(config: ExtensionConfig) {
  if (config.type !== "mcp-stdio") return;
  if (!localProcessConnectionsAllowed()) throw new ApiError({ code: "FORBIDDEN", message: "本地进程扩展仅在桌面应用中可用。" });
  // An installed executable is explicit; never resolve a shell or install command from PATH.
  if (!path.isAbsolute(config.command) || !path.isAbsolute(config.cwd) ||
    (process.platform === "win32" && !config.command.toLowerCase().endsWith(".exe")) ||
    /^(cmd|powershell|pwsh|bash|sh|wscript|cscript)(\.exe)?$/i.test(path.basename(config.command))) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "请选择已安装程序和工作目录的绝对路径；不支持 Shell、脚本启动器或安装命令。" });
  }
  const [program, directory] = await Promise.all([stat(config.command).catch(() => null), stat(config.cwd).catch(() => null)]);
  if (!program?.isFile() || !directory?.isDirectory()) throw new ApiError({ code: "VALIDATION_ERROR", message: "程序或工作目录不存在。" });
}

async function boundedResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (!response.body) return response;
  const reader = response.body.getReader(); let size = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted();
        const item = await reader.read();
        if (item.done) { controller.close(); return; }
        size += item.value.byteLength;
        if (size > EXTENSION_LIMITS.responseBytes) { await reader.cancel(); throw new ApiError({ code: "PAYLOAD_TOO_LARGE", message: "扩展响应超过 512 KiB 限制。" }); }
        controller.enqueue(item.value);
      } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function extensionFetch(endpoint: string, signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    const expected = new URL(endpoint);
    if (target.origin !== expected.origin || target.pathname !== expected.pathname) throw new ApiError({ code: "FORBIDDEN", message: "扩展只能请求配置的接口地址。" });
    return boundedResponse(await fetch(input, { ...init, redirect: "error", signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) }), signal);
  };
}

async function withMcp<T>(config: Exclude<ExtensionConfig, { type: "http" }>, credentials: Record<string, string>, signal: AbortSignal, action: (client: Client) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  await validateProcessConfig(config);
  connectionCredentials(config, credentials);
  const transport = config.type === "mcp-http"
    ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: credentials, redirect: "error" }, fetch: extensionFetch(config.url, signal), reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } })
    : new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env: { ...credentials, ...(config.command === process.execPath && process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) }, stderr: "ignore", maxBufferSize: EXTENSION_LIMITS.responseBytes });
  const client = new Client({ name: "ria", version: "1" }, { capabilities: {}, jsonSchemaValidator: {
    getValidator<T>(schema: object) {
      const validate = validateToolSchema(schema);
      return (input: unknown) => validate(input) ? { valid: true as const, data: input as T, errorMessage: undefined } : { valid: false as const, data: undefined, errorMessage: "Extension output does not match its schema" };
    },
  } });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    // Windows child programs may own subprocesses. Stop the owned tree before
    // releasing its process identity, then let the SDK settle pending requests.
    if (transport instanceof StdioClientTransport && transport.pid && process.platform === "win32") {
      await new Promise<void>(resolve => execFile(path.join(process.env.SystemRoot ?? "C:/Windows", "System32/taskkill.exe"), ["/PID", String(transport.pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, () => resolve()));
    }
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  })();
  const abort = () => { void close(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await client.connect(transport, { signal, timeout: EXTENSION_LIMITS.timeoutMs });
    signal.throwIfAborted();
    return await action(client);
  } finally { signal.removeEventListener("abort", abort); await close(); }
}

async function discover(client: Client, signal: AbortSignal): Promise<ExtensionTool[]> {
  if (!client.getServerCapabilities()?.tools) return [];
  const tools: ExtensionTool[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: EXTENSION_LIMITS.timeoutMs });
    tools.push(...extensionToolsSchema.parse(result.tools.map(tool => ({ name: tool.name, description: tool.description ?? tool.name, inputSchema: tool.inputSchema, enabled: false }))));
    if (tools.length > EXTENSION_LIMITS.tools) throw new ApiError({ code: "VALIDATION_ERROR", message: "单个扩展最多支持 64 个工具，请在服务端缩小工具范围。" });
    cursor = result.nextCursor;
    if (cursor && cursors.has(cursor)) throw new ApiError({ code: "UPSTREAM_FAILED", message: "扩展返回了重复的工具分页。" });
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return extensionToolsSchema.parse(tools);
}

export async function probeConnection(config: ExtensionConfig, credentials: Record<string, string>, signal: AbortSignal): Promise<ExtensionTool[]> {
  connectionCredentials(config, credentials);
  if (config.type !== "http") return withMcp(config, credentials, signal, client => discover(client, signal));
  // HEAD checks reachability and credentials without sending the configured business operation.
  const response = await extensionFetch(config.url, signal)(config.url, { method: "HEAD", headers: credentials });
  await response.body?.cancel();
  if (!response.ok && response.status !== 405) throw new ApiError({ code: "UPSTREAM_FAILED", message: `连接检测返回 HTTP ${response.status}，请检查地址和凭据。` });
  return [{ name: "request", description: config.description, inputSchema: config.inputSchema, enabled: false }];
}

function sameDefinition(a: ExtensionTool, b: ExtensionTool) {
  return canonical({ name: a.name, description: a.description, inputSchema: a.inputSchema }) === canonical({ name: b.name, description: b.description, inputSchema: b.inputSchema });
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
export { sameDefinition };

export async function callConnection(config: ExtensionConfig, credentials: Record<string, string>, tool: ExtensionTool, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  connectionCredentials(config, credentials);
  if (config.type !== "http") return withMcp(config, credentials, signal, async client => {
    const current = (await discover(client, signal)).find(item => item.name === tool.name);
    if (!current || !sameDefinition(current, tool)) throw new ApiError({ code: "CONFLICT", message: "扩展工具定义已变化，请在扩展管理页重新检测并确认工具。" });
    const result = await client.callTool({ name: tool.name, arguments: args }, undefined, { signal, timeout: EXTENSION_LIMITS.timeoutMs });
    if (result.isError) throw new ApiError({ code: "UPSTREAM_FAILED", message: "扩展工具执行失败，请检查该服务。" });
    return result;
  });
  const url = new URL(config.url);
  if (config.method === "GET") for (const [key, value] of Object.entries(args)) url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
  const response = await extensionFetch(config.url, signal)(url, { method: config.method, headers: { ...credentials, "Content-Type": "application/json" }, ...(config.method === "GET" ? {} : { body: JSON.stringify(args) }) });
  if (!response.ok) { await response.body?.cancel(); throw new ApiError({ code: "UPSTREAM_FAILED", message: `扩展接口返回 HTTP ${response.status}。` }); }
  const text = await response.text();
  if (!text) return null;
  if (response.headers.get("content-type")?.includes("json")) {
    try { return JSON.parse(text); } catch { throw new ApiError({ code: "UPSTREAM_FAILED", message: "扩展返回了无效 JSON。" }); }
  }
  return text;
}

export function publicExtensionError(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return new ApiError({ code: signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CONFLICT", message: signal.reason?.name === "TimeoutError" ? "扩展操作超时。" : "扩展操作已取消或配置已变化。" });
  if (error instanceof ApiError) return error;
  return new ApiError({ code: "UPSTREAM_FAILED", message: "扩展连接或响应无效，请检查地址、程序、凭据和服务状态。" });
}
