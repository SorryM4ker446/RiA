import { z } from "zod";
import { ApiError } from "@/lib/server/api-error";
import { setupServerProxy } from "@/lib/server/proxy";
import { extensionConfigSchema, credentialSchema } from "./schema";
import { connectionCredentials } from "./transport";
import type { RegistryPage, RegistryRemote, RegistryServer } from "./registry-types";

const REGISTRY_ORIGIN = "https://registry.modelcontextprotocol.io";
export const REGISTRY_LIMITS = { pageSize: 20, responseBytes: 1_048_576, timeoutMs: 10_000, cacheMs: 3_600_000, cacheEntries: 64 } as const;
const text = (max: number) => z.string().max(max);
const nameSchema = text(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const versionSchema = text(255).min(1).regex(/^[^\s\u0000-\u001f\u007f]+$/);
export const registryQuerySchema = z.strictObject({
  search: text(100).trim().regex(/^[^\u0000-\u001f\u007f]*$/).default(""),
  cursor: text(2048).min(1).optional(),
});
export const registryDetailQuerySchema = z.strictObject({ name: nameSchema, version: versionSchema.refine(value => !["latest", ".", ".."].includes(value), "Select an exact listed version") });
const headerSchema = z.object({
  name: text(100).min(1), description: text(2000).default(""),
  isRequired: z.boolean().default(false), isSecret: z.boolean().default(false),
  value: text(4096).optional(), default: text(4096).optional(), placeholder: text(4096).optional(),
});
const remoteSchema = z.object({ type: text(40).min(1), url: text(2048).default(""), headers: z.array(headerSchema).max(20).default([]) });
const serverSchema = z.object({
  server: z.object({
    name: nameSchema, title: text(200).optional(), description: text(6000).default(""), version: versionSchema,
    repository: z.object({ url: text(2048) }).optional(), websiteUrl: text(2048).optional(),
    remotes: z.array(z.unknown()).max(32).default([]),
    packages: z.array(z.object({ registryType: text(40), identifier: text(2000), version: text(255).optional(), transport: z.object({ type: text(40) }) })).max(32).default([]),
  }),
  _meta: z.object({ "io.modelcontextprotocol.registry/official": z.object({ status: z.enum(["active", "deprecated", "deleted"]), updatedAt: text(100).optional() }) }),
});
const pageSchema = z.object({ servers: z.array(z.unknown()).max(100), metadata: z.object({ nextCursor: text(2048).nullish() }).optional() });
const cache = new Map<string, { expires: number; value: unknown }>();
const unavailable = () => new ApiError({ code: "UPSTREAM_FAILED", message: "MCP 官方目录暂时不可用，请稍后重试；已有连接仍可使用。" });
const hasVariables = (value: string) => /[{}]|%7[bd]/i.test(value);

function safeLink(value?: string): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

function normalizeRemote(input: unknown): RegistryRemote {
  const parsed = remoteSchema.safeParse(input);
  if (!parsed.success) return { type: "unknown", url: "", headers: [], unavailableReason: "连接元数据格式不受支持，请参阅项目说明后手动配置。" };
  const remote = parsed.data;
  const headers = remote.headers.map(header => {
    const candidate = header.value ?? header.default ?? "";
    return { key: header.name, value: header.isSecret || hasVariables(candidate) ? "" : candidate, required: header.isRequired, description: header.description, placeholder: header.placeholder || (hasVariables(candidate) ? candidate : "请输入完整请求头值") };
  });
  let unavailableReason: string | null = null;
  if (remote.type !== "streamable-http") unavailableReason = "当前仅支持 Streamable HTTP；此传输方式需要其他客户端或手动适配。";
  else if (hasVariables(remote.url)) unavailableReason = "接口地址包含变量，请参阅项目说明填写实际地址后手动添加。";
  else if (!extensionConfigSchema.safeParse({ type: "mcp-http", url: remote.url }).success) unavailableReason = "接口地址不符合现有连接要求：需 HTTP(S) 地址，且不含账号、查询参数或片段。";
  else {
    try {
      const values = Object.fromEntries(headers.map(header => [header.key, header.value || "required"]));
      if (!credentialSchema.safeParse(values).success || new Set(headers.map(header => header.key.toLowerCase())).size !== headers.length) throw new Error();
      connectionCredentials({ type: "mcp-http", url: remote.url }, values);
    } catch { unavailableReason = "请求头格式超出当前连接支持范围，请参阅项目说明后手动配置。"; }
  }
  return { type: remote.type, url: remote.url, headers, unavailableReason };
}

function normalizeServer(input: unknown): RegistryServer | null {
  const parsed = serverSchema.safeParse(input);
  if (!parsed.success) return null;
  const { server, _meta } = parsed.data;
  const official = _meta["io.modelcontextprotocol.registry/official"];
  if (official.status === "deleted") return null;
  const date = official.updatedAt ? new Date(official.updatedAt) : null;
  return {
    name: server.name, title: server.title?.trim() || server.name.split("/").at(-1)!, description: server.description,
    version: server.version, status: official.status,
    repositoryUrl: safeLink(server.repository?.url), websiteUrl: safeLink(server.websiteUrl),
    updatedAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
    remotes: server.remotes.map(normalizeRemote),
    packages: server.packages.map(item => ({ registry: item.registryType, identifier: item.identifier, version: item.version ?? "未注明", transport: item.transport.type })),
  };
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > REGISTRY_LIMITS.responseBytes) { await response.body?.cancel(); throw unavailable(); }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > REGISTRY_LIMITS.responseBytes) throw unavailable();
      chunks.push(result.value);
    }
    signal.throwIfAborted();
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw unavailable(); }
  } finally { signal.removeEventListener("abort", abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function fetchRegistry<T>(path: string, signal: AbortSignal, parse: (value: unknown) => T): Promise<T> {
  signal.throwIfAborted();
  const saved = cache.get(path);
  if (saved && saved.expires > Date.now()) return structuredClone(saved.value) as T;
  cache.delete(path);
  const timeout = AbortSignal.timeout(REGISTRY_LIMITS.timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    setupServerProxy();
    // Only the fixed official registry receives this request. Never forward
    // workspace cookies, model keys or credentials from installed connections.
    const response = await fetch(`${REGISTRY_ORIGIN}${path}`, { headers: { Accept: "application/json" }, credentials: "omit", cache: "no-store", redirect: "error", signal: combined });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw new ApiError({ code: "NOT_FOUND", message: "该扩展或版本已不在官方目录中，请重新搜索。" });
      throw unavailable();
    }
    const value = parse(await readJson(response, combined));
    combined.throwIfAborted();
    if (cache.size >= REGISTRY_LIMITS.cacheEntries) cache.delete(cache.keys().next().value!);
    cache.set(path, { value: structuredClone(value), expires: Date.now() + REGISTRY_LIMITS.cacheMs });
    return value;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (timeout.aborted) throw new ApiError({ code: "TIMEOUT", message: "MCP 官方目录请求超时，请稍后重试。" });
    if (error instanceof ApiError) throw error;
    throw unavailable();
  }
}

export async function searchRegistry(input: z.infer<typeof registryQuerySchema>, signal: AbortSignal): Promise<RegistryPage> {
  const query = registryQuerySchema.parse(input);
  const params = new URLSearchParams({ limit: String(REGISTRY_LIMITS.pageSize), version: "latest" });
  if (query.search) params.set("search", query.search);
  if (query.cursor) params.set("cursor", query.cursor);
  return fetchRegistry(`/v0.1/servers?${params}`, signal, raw => {
    const result = pageSchema.safeParse(raw);
    if (!result.success) throw unavailable();
    const nextCursor = result.data.metadata?.nextCursor || null;
    if (nextCursor && nextCursor === query.cursor) throw unavailable();
    const unique = new Map<string, RegistryServer>();
    let skipped = 0;
    for (const item of result.data.servers) {
      const server = normalizeServer(item);
      if (server && !unique.has(server.name)) unique.set(server.name, server); else skipped++;
    }
    return { items: [...unique.values()], nextCursor, skipped, fetchedAt: new Date().toISOString() };
  });
}

export async function getRegistryServer(input: z.infer<typeof registryDetailQuerySchema>, signal: AbortSignal): Promise<RegistryServer> {
  const query = registryDetailQuerySchema.parse(input);
  return fetchRegistry(`/v0.1/servers/${encodeURIComponent(query.name)}/versions/${encodeURIComponent(query.version)}`, signal, raw => {
    const server = normalizeServer(raw);
    if (!server || server.name !== query.name || server.version !== query.version) throw unavailable();
    return server;
  });
}
