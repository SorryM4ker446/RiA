import { randomUUID } from "node:crypto";
import type { Extension, Prisma } from "@prisma/client";
import { db } from "@/db";
import { ApiError } from "@/lib/server/api-error";
import { cancelExtensionOperations, startExtensionOperation } from "./activity";
import { credentialEncryptionAvailable, decryptCredentials, encryptCredentials } from "./secrets";
import { activationSchema, EXTENSION_LIMITS, extensionConfigSchema, extensionToolsSchema, externalToolId, saveExtensionSchema, type SaveExtension } from "./schema";
import { canonical, connectionCredentials, probeConnection, publicExtensionError, sameDefinition, validateProcessConfig } from "./transport";
import { pluginManifestSchema } from "@/lib/plugins/schema";

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const conflict = () => new ApiError({ code: "CONFLICT", message: "扩展配置已变化，请刷新后重试。" });
export async function requireExtension(id: string) {
  const extension = await db.extension.findUnique({ where: { id }, include: { plugin: true } });
  if (!extension) throw new ApiError({ code: "NOT_FOUND", message: "扩展不存在或已删除。" });
  return extension;
}
export function extensionView(row: Extension & { plugin?: { manifest: unknown } | null }) {
  const tools = extensionToolsSchema.parse(row.tools);
  let credentialsAvailable = true;
  if (row.credentials) { try { decryptCredentials(row.id, row.credentials); } catch { credentialsAvailable = false; } }
  const credentialFields = row.plugin ? pluginManifestSchema.parse(row.plugin.manifest).connections.find(connection => connection.id === row.pluginKey)?.credentials ?? [] : [];
  return { id: row.id, name: row.name, kind: row.kind, config: extensionConfigSchema.parse(row.config), revision: row.revision, enabled: row.enabled, pluginId: row.pluginId, credentialFields, hasCredentials: !!row.credentials, credentialsAvailable, tested: row.testedRevision === row.revision, lastTestAt: row.lastTestAt?.toISOString() ?? null, error: row.lastError, tools: tools.map(tool => ({ ...tool, id: externalToolId(row.id, tool.name) })) };
}
export type ExtensionView = ReturnType<typeof extensionView>;
export async function listExtensions() {
  return { items: (await db.extension.findMany({ include: { plugin: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map(extensionView), encryptionAvailable: credentialEncryptionAvailable() };
}

export async function saveExtension(raw: SaveExtension, id?: string) {
  const input = saveExtensionSchema.parse(raw), extensionId = id ?? randomUUID();
  await validateProcessConfig(input.config);
  if (input.credentials) connectionCredentials(input.config, input.credentials);
  if (id && !input.revision) throw conflict();
  const row = await db.$transaction(async tx => {
    if (!id) {
      if (await tx.extension.count() >= EXTENSION_LIMITS.connections) throw new ApiError({ code: "VALIDATION_ERROR", message: "最多配置 20 个扩展。" });
      return tx.extension.create({ data: { id: extensionId, name: input.name, kind: input.config.type, config: json(input.config), tools: [], credentials: encryptCredentials(extensionId, input.credentials ?? {}) } });
    }
    const current = await tx.extension.findUnique({ where: { id } });
    if (!current || current.revision !== input.revision) throw conflict();
    const previous = extensionConfigSchema.parse(current.config);
    const identity = (config: typeof previous) => config.type === "mcp-stdio" ? canonical({ type: config.type, command: config.command, args: config.args, cwd: config.cwd }) : canonical({ type: config.type, url: config.url });
    const keepCredentials = identity(previous) === identity(input.config) && !input.clearCredentials;
    return tx.extension.update({ where: { id, revision: input.revision }, data: { name: input.name, kind: input.config.type, config: json(input.config), enabled: false, revision: { increment: 1 }, testedRevision: null, testId: null, lastError: null, tools: [], credentials: input.credentials ? encryptCredentials(id, input.credentials) : keepCredentials ? current.credentials : null } });
  });
  if (id) cancelExtensionOperations(id);
  return extensionView(await requireExtension(row.id));
}

export async function testExtension(id: string, revision: number, signal?: AbortSignal) {
  const current = await requireExtension(id);
  if (current.revision !== revision) throw conflict();
  const token = randomUUID();
  const started = await db.extension.updateMany({ where: { id, revision }, data: { testId: token } });
  if (!started.count) throw conflict();
  const operation = startExtensionOperation(id, signal);
  try {
    const config = extensionConfigSchema.parse(current.config);
    const credentials = decryptCredentials(id, current.credentials);
    const matchingKey = (key: string) => config.type === "mcp-stdio" && process.platform !== "win32" ? key : key.toLowerCase();
    if (extensionView(current).credentialFields.some(field => field.required && !Object.entries(credentials).some(([key, value]) => matchingKey(key) === matchingKey(field.key) && value))) throw new ApiError({ code: "CONFIGURATION_ERROR", message: "请先在连接配置中填写插件要求的凭据。" });
    const tools = await probeConnection(config, credentials, operation.signal);
    operation.signal.throwIfAborted();
    const previous = extensionToolsSchema.parse(current.tools);
    const changed = tools.length !== previous.length || tools.some(tool => !previous.some(old => sameDefinition(old, tool)));
    const nextRevision = changed ? revision + 1 : revision;
    const saved = await db.extension.updateMany({ where: { id, revision, testId: token }, data: { tools: json(tools.map(tool => ({ ...tool, enabled: !changed && previous.some(old => old.name === tool.name && old.enabled) }))), enabled: changed ? false : current.enabled, revision: nextRevision, testedRevision: nextRevision, testId: null, lastTestAt: new Date(), lastError: null } });
    if (!saved.count) throw conflict();
    if (changed) cancelExtensionOperations(id);
    return extensionView(await requireExtension(id));
  } catch (error) {
    const failure = publicExtensionError(error, operation.signal);
    await db.extension.updateMany({ where: { id, revision, testId: token }, data: { testId: null, ...(operation.signal.aborted ? {} : { enabled: false, testedRevision: null, lastTestAt: new Date(), lastError: failure.message }) } });
    throw failure;
  } finally { operation.finish(); }
}

export async function activateExtension(id: string, raw: unknown) {
  const input = activationSchema.parse(raw);
  const saved = await db.$transaction(async tx => {
    const row = await tx.extension.findUnique({ where: { id } });
    if (!row || row.revision !== input.revision) throw conflict();
    if (input.enabled && row.testedRevision !== row.revision) throw new ApiError({ code: "VALIDATION_ERROR", message: "请先成功检测连接和工具，再启用扩展。" });
    const tools = extensionToolsSchema.parse(row.tools);
    const selected = new Set(input.tools);
    if (selected.size !== input.tools.length || input.tools.some(name => !tools.some(tool => tool.name === name))) throw new ApiError({ code: "VALIDATION_ERROR", message: "工具选择无效，请重新检测。" });
    if (input.enabled && !selected.size) throw new ApiError({ code: "VALIDATION_ERROR", message: "请至少选择一个工具。" });
    const others = await tx.extension.findMany({ where: { enabled: true, id: { not: id } }, select: { tools: true } });
    const total = others.reduce((sum, item) => sum + extensionToolsSchema.parse(item.tools).filter(tool => tool.enabled).length, 0) + (input.enabled ? selected.size : 0);
    if (total > EXTENSION_LIMITS.enabledTools) throw new ApiError({ code: "VALIDATION_ERROR", message: "最多同时启用 32 个外部工具，请缩小选择范围。" });
    const revision = row.revision + 1;
    return tx.extension.update({ where: { id, revision: input.revision }, data: { enabled: input.enabled, tools: json(tools.map(tool => ({ ...tool, enabled: selected.has(tool.name) }))), revision, testedRevision: row.testedRevision === row.revision ? revision : null, testId: null } });
  });
  cancelExtensionOperations(id);
  return extensionView(await requireExtension(saved.id));
}

export async function deleteExtension(id: string, revision: number) {
  if ((await requireExtension(id)).pluginId) throw new ApiError({ code: "CONFLICT", message: "此连接由插件管理，请通过卸载插件移除。" });
  const removed = await db.extension.deleteMany({ where: { id, revision } });
  if (!removed.count) throw conflict();
  cancelExtensionOperations(id);
}
